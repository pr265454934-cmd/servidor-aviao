/**
 * server.js — Backend do Simulador de Voo Multiplayer
 * ---------------------------------------------------------------------------
 * Requer: npm install ws
 * Rodar:  node server.js
 *
 * ATENÇÃO (leia antes de colocar isso na internet):
 * A regra "o primeiro que conectar vira administrador" NÃO é autenticação de
 * verdade — é apenas uma convenção de ordem de chegada. Qualquer pessoa que
 * conecte no servidor antes de você vira 'paulodmf123' com poder total sobre
 * os outros jogadores. Isso é seguro apenas se VOCÊ SEMPRE for a primeira
 * conexão logo após ligar o servidor (por exemplo, testando localmente antes
 * de divulgar o link). Deixei pronta, comentada logo abaixo, uma alternativa
 * mais segura baseada em uma chave secreta (ADMIN_SECRET) — recomendo migrar
 * para ela assim que possível.
 * ---------------------------------------------------------------------------
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const ADMIN_NAME = 'paulodmf123';
const BLOCKED_SUBSTRING = 'dmf';
const PLANE_PRICES = { jato2: 200, jato3: 200, jato4: 200 };
const LANDING_COOLDOWN_MS = 5000;   // anti-exploit: evita farm de moedas repetindo o evento "pousei"
const MAX_MESSAGE_BYTES = 4000;     // anti-exploit: descarta pacotes anormalmente grandes
const STATE_RATE_LIMIT_MS = 40;     // ~25 atualizações de posição por segundo, no máximo

// -----------------------------------------------------------------------
// ALTERNATIVA MAIS SEGURA (desativada por padrão) — descomente para usar
// uma chave secreta em vez da regra "primeiro a chegar":
//
// const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
// // No handleLogin, em vez de "if (!adminAssigned)", use:
// // if (ADMIN_SECRET && msg.adminKey === ADMIN_SECRET) { ...vira admin... }
// -----------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ESTADO DO SERVIDOR (tudo em memória — reinicia zerado a cada "node server.js")
// ---------------------------------------------------------------------------
let adminSocket = null;      // referência REAL da conexão do admin — nunca confiar em dado vindo do cliente
let adminAssigned = false;   // true assim que o primeiro jogador se conecta
let maintenanceMode = false;

const players = new Map();       // ws -> { id, name, role, coins, planesOwned, ip, lastLanding, lastState }
const bannedByIp = new Map();    // ip -> { until: timestamp|null }  (null = permanente)
const mutedIds = new Set();      // ids silenciados

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* conexão pode ter caído no meio do envio */ }
  }
}

function broadcast(obj, exceptWs = null) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== exceptWs) client.send(data);
  }
}

function publicPlayerList() {
  return [...players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    muted: mutedIds.has(p.id),
    coins: p.coins
  }));
}

function findWsById(id) {
  for (const [ws, p] of players.entries()) if (p.id === id) return ws;
  return null;
}

function isBannedIp(ip) {
  const ban = bannedByIp.get(ip);
  if (!ban) return false;
  if (ban.until === null) return true;         // permanente
  if (Date.now() > ban.until) { bannedByIp.delete(ip); return false; } // suspensão expirou
  return true;
}

function isProtectedAdmin(targetPlayer) {
  // Imunidade total do ADM: não pode ser banido, silenciado nem rebaixado por ninguém
  return !!targetPlayer && targetPlayer.name.toLowerCase() === ADMIN_NAME.toLowerCase();
}

function kick(ws, reason) {
  safeSend(ws, { type: 'kicked', reason });
  setTimeout(() => { try { ws.terminate(); } catch (e) {} }, 150); // dá tempo do aviso chegar antes de derrubar
}

// ---------------------------------------------------------------------------
// CONEXÃO
// ---------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
  ws.__ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.__lastStateAt = 0;

  if (isBannedIp(ws.__ip)) {
    safeSend(ws, { type: 'loginError', reason: 'Você está banido deste servidor.' });
    return ws.terminate();
  }

  ws.on('message', (raw) => {
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return; // anti-exploit: pacote suspeito, descarta
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }    // anti-exploit: JSON inválido, descarta
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'login':         return handleLogin(ws, msg);
      case 'state':         return handleState(ws, msg);
      case 'landed':        return handleLanded(ws);
      case 'buyPlane':      return handleBuyPlane(ws, msg);
      case 'explosion':     return handleExplosion(ws, msg);
      case 'chat':          return handleChat(ws, msg);
      case 'adminCommand':  return handleAdminCommand(ws, msg);
      default: return; // tipo desconhecido — ignora silenciosamente
    }
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p) {
      players.delete(ws);
      broadcast({ type: 'playerLeft', id: p.id });
      broadcast({ type: 'playerList', players: publicPlayerList() });
      if (ws === adminSocket) adminSocket = null; // admin caiu; ninguém mais assume o posto
    }
  });
});

// ---------------------------------------------------------------------------
// LOGIN — nome obrigatório, regra do primeiro a chegar, filtro de sigla,
// modo manutenção e checagem de nomes duplicados
// ---------------------------------------------------------------------------
function handleLogin(ws, msg) {
  if (players.has(ws)) return; // já logado, ignora segunda tentativa

  const rawName = (msg.name || '').toString().trim();
  if (!rawName || rawName.length < 3 || rawName.length > 20 || !/^[a-zA-Z0-9_]+$/.test(rawName)) {
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }

  const nameLower = rawName.toLowerCase();
  const isClaimingAdminName = nameLower === ADMIN_NAME.toLowerCase();

  // Bloqueio de sigla secreta: só o próprio admin pode ter "dmf" no nome
  if (!isClaimingAdminName && nameLower.includes(BLOCKED_SUBSTRING)) {
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }

  // Regra do primeiro a chegar: a primeiríssima conexão do servidor vira o admin
  if (!adminAssigned) {
    adminAssigned = true;
    adminSocket = ws;
    ws.__isAdmin = true;
    return finishLogin(ws, ADMIN_NAME, 'admin');
  }

  // Depois que o posto já foi ocupado, ninguém mais pode logar como paulodmf123
  if (isClaimingAdminName) {
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }

  if (maintenanceMode) {
    return safeSend(ws, { type: 'loginError', reason: 'Servidor em manutenção.' });
  }

  for (const p of players.values()) {
    if (p.name.toLowerCase() === nameLower) {
      return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
    }
  }

  finishLogin(ws, rawName, 'player');
}

function finishLogin(ws, name, role) {
  const id = makeId();
  const player = {
    id, name, role,
    coins: role === 'admin' ? 9999 : 0,
    planesOwned: role === 'admin' ? ['jato1', 'jato2', 'jato3', 'jato4'] : ['jato1'],
    ip: ws.__ip,
    lastLanding: 0
  };
  players.set(ws, player);

  safeSend(ws, {
    type: 'loginOk',
    id, name, role,
    isAdmin: role === 'admin',
    coins: player.coins,
    planesOwned: player.planesOwned,
    maintenanceMode
  });
  broadcast({ type: 'playerJoined', id, name }, ws);
  broadcast({ type: 'playerList', players: publicPlayerList() });
}

// ---------------------------------------------------------------------------
// SINCRONIZAÇÃO DE JOGO (posição, pouso, loja, explosão, chat)
// ---------------------------------------------------------------------------
function handleState(ws, msg) {
  const p = players.get(ws);
  if (!p) return;
  const now = Date.now();
  if (now - ws.__lastStateAt < STATE_RATE_LIMIT_MS) return; // anti-flood
  ws.__lastStateAt = now;

  // Validação básica de sanidade dos números recebidos (anti-exploit)
  const { x, y, z, qx, qy, qz, qw } = msg;
  const nums = [x, y, z, qx, qy, qz, qw];
  if (nums.some((n) => typeof n !== 'number' || !isFinite(n))) return;

  broadcast({ type: 'remoteState', id: p.id, name: p.name, x, y, z, qx, qy, qz, qw }, ws);
}

function handleLanded(ws) {
  const p = players.get(ws);
  if (!p) return;
  const now = Date.now();
  if (now - p.lastLanding < LANDING_COOLDOWN_MS) return; // anti-exploit: farm de moedas
  p.lastLanding = now;

  if (p.role !== 'admin') p.coins += 10;
  safeSend(ws, { type: 'coinsUpdate', coins: p.coins });
}

function handleBuyPlane(ws, msg) {
  const p = players.get(ws);
  if (!p) return;
  const planeId = msg.planeId;
  if (!PLANE_PRICES[planeId] || p.planesOwned.includes(planeId)) return;

  if (p.role === 'admin') {
    p.planesOwned.push(planeId);
  } else {
    if (p.coins < PLANE_PRICES[planeId]) {
      return safeSend(ws, { type: 'buyError', reason: 'Moedas insuficientes.' });
    }
    p.coins -= PLANE_PRICES[planeId];
    p.planesOwned.push(planeId);
  }
  safeSend(ws, { type: 'buyOk', planeId, coins: p.coins, planesOwned: p.planesOwned });
}

function handleExplosion(ws, msg) {
  const p = players.get(ws);
  if (!p) return;
  const { x, y, z } = msg;
  if ([x, y, z].some((n) => typeof n !== 'number' || !isFinite(n))) return;
  // Retransmite para todo mundo ver a megaexplosão sincronizada
  broadcast({ type: 'remoteExplosion', x, y, z, by: p.name });
}

function handleChat(ws, msg) {
  const p = players.get(ws);
  if (!p) return;
  if (mutedIds.has(p.id)) {
    return safeSend(ws, { type: 'chatBlocked', reason: 'Você está silenciado.' });
  }
  const text = (msg.text || '').toString().slice(0, 200);
  if (!text.trim()) return;
  broadcast({ type: 'chat', name: p.name, text });
}

// ---------------------------------------------------------------------------
// PAINEL DE ADM — só executa se vier EXATAMENTE do socket salvo do admin.
// Isso é o "anti-script de interface": nenhum dado enviado pelo cliente
// (nome, id, flag "sou admin") é usado para decidir permissão — só a própria
// referência de conexão TCP/WebSocket que já validamos no login.
// ---------------------------------------------------------------------------
function handleAdminCommand(ws, msg) {
  if (ws !== adminSocket || !ws.__isAdmin) return; // rejeita qualquer tentativa de injeção client-side

  const targetWs = msg.targetId ? findWsById(msg.targetId) : null;
  const target = targetWs ? players.get(targetWs) : null;

  switch (msg.action) {
    case 'mute':
      if (target && !isProtectedAdmin(target)) {
        mutedIds.add(target.id);
        safeSend(targetWs, { type: 'serverNotice', text: 'Você foi silenciado pelo administrador.' });
      }
      break;

    case 'unmute':
      if (target) mutedIds.delete(target.id);
      break;

    case 'suspend': {
      if (!target || isProtectedAdmin(target)) break;
      const days = Math.max(1, Math.min(365, parseInt(msg.days, 10) || 1));
      bannedByIp.set(target.ip, { until: Date.now() + days * 86400000 });
      kick(targetWs, `Você foi suspenso por ${days} dia(s) pelo administrador.`);
      break;
    }

    case 'banPermanent':
      if (target && !isProtectedAdmin(target)) {
        bannedByIp.set(target.ip, { until: null });
        kick(targetWs, 'Você foi banido permanentemente pelo administrador.');
      }
      break;

    case 'unban':
      if (msg.ip) bannedByIp.delete(msg.ip);
      break;

    case 'promoteVice':
      if (target && !isProtectedAdmin(target)) {
        target.role = 'vice-admin';
        safeSend(targetWs, { type: 'serverNotice', text: 'Você foi promovido a Vice-Administrador.' });
      }
      break;

    case 'toggleMaintenance':
      maintenanceMode = !maintenanceMode;
      broadcast({
        type: 'serverNotice',
        text: maintenanceMode ? 'Servidor em manutenção.' : 'Servidor voltou ao normal.'
      });
      break;

    case 'shutdown':
      broadcast({ type: 'serverNotice', text: 'Servidor sendo encerrado pelo Administrador' });
      setTimeout(() => {
        for (const client of wss.clients) { try { client.terminate(); } catch (e) {} }
        process.exit(0);
      }, 600); // pequena folga para o aviso chegar antes da queda do processo
      return; // não precisa reenviar playerList, o processo já vai cair

    default:
      return;
  }

  broadcast({ type: 'playerList', players: publicPlayerList() });
}

console.log(`Servidor do simulador de voo rodando na porta ${PORT}`);
console.log('Aguardando a primeira conexão, que virá a ser o Administrador Supremo (paulodmf123)...');
