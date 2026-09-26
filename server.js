/**
 * server.js — Backend do Simulador de Voo Multiplayer
 * ---------------------------------------------------------------------------
 * Requer: npm install ws
 * Rodar:  node server.js
 *
 * Como o admin funciona agora: a PRIMEIRA pessoa a se conectar usando o nome
 * paulodmf123 vira o administrador. Nesse momento o servidor gera um código
 * secreto sozinho (ninguém digita nada) e manda pro navegador dela guardar.
 * Da próxima vez que abrir o jogo com esse mesmo navegador e digitar
 * paulodmf123 de novo, o código salvo é enviado automaticamente e ela é
 * reconhecida na hora — sem senha, sem link especial, sem prompt.
 * Depois que o posto já foi reivindicado uma vez, o bloqueio do trecho "dmf"
 * no nome só continua valendo pro nome EXATO paulodmf123 (que passa a exigir
 * o código salvo) — outros jogadores podem ter "dmf" em algum lugar do nome
 * sem problema, só não podem repetir nomes já em uso.
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
const DEVICE_SWITCH_WINDOW_MS = 10 * 60 * 1000; // a autorização de trocar de dispositivo dura 10 minutos

// Normaliza texto pra comparar sem se importar com maiúscula/minúscula,
// acentos, pontuação ou espaços extras — assim um pequeno erro de digitação
// na frase de recuperação não trava o admin de verdade.
function normalizePhrase(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Frase de recuperação de admin — usada só pra reconhecer o admin num
// dispositivo NOVO, e só depois de autorizado no painel (veja armDeviceSwitch).
const ADMIN_RECOVERY_PHRASE = normalizePhrase(
  'SÃO PODERES DA UNIÃO, INDEPENDENTES E HARMÔNICOS ENTRE SI, O LEGISLATIVO, O EXECUTIVO E O JUDICIÁRIO ###555###0026092014'
);

// ---------------------------------------------------------------------------
// ESTADO DO SERVIDOR (tudo em memória — reinicia zerado a cada "node server.js")
// ---------------------------------------------------------------------------
let adminSocket = null;      // referência REAL da conexão do admin — nunca confiar em dado vindo do cliente
let adminAssigned = false;   // true assim que alguém reivindica paulodmf123 pela primeira vez
let adminToken = null;       // código gerado sozinho pelo servidor nessa hora — guardado pelo navegador do admin
let deviceSwitchArmed = false;   // true só depois que o admin autorizar a troca de dispositivo no painel
let deviceSwitchArmedAt = 0;
let maintenanceMode = false;

const players = new Map();       // ws -> { id, name, role, coins, planesOwned, ip, lastLanding, lastState }
const bannedByIp = new Map();    // ip -> { until: timestamp|null }  (null = permanente)
const mutedIds = new Set();      // ids silenciados
const knownNames = new Map();    // nomeMinúsculo -> { name, role, online } — "existe" enquanto o servidor não reiniciar

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
      case 'adminRecover':  return handleAdminRecover(ws, msg);
      case 'checkPlayer':   return handleCheckPlayer(ws, msg);
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
      const known = knownNames.get(p.name.toLowerCase());
      if (known) known.online = false;
      broadcast({ type: 'playerLeft', id: p.id });
      broadcast({ type: 'playerList', players: publicPlayerList() });
      if (ws === adminSocket) adminSocket = null; // admin caiu; ninguém mais assume o posto
    }
  });
});

// ---------------------------------------------------------------------------
// LOGIN — nome obrigatório, regra do primeiro a chegar (com reconhecimento
// automático de retorno), filtro de sigla, modo manutenção e nomes duplicados
// ---------------------------------------------------------------------------
function handleLogin(ws, msg) {
  if (players.has(ws)) return; // já logado, ignora segunda tentativa

  const rawName = (msg.name || '').toString().trim();
  if (!rawName || rawName.length < 3 || rawName.length > 20 || !/^[a-zA-Z0-9_]+$/.test(rawName)) {
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }

  const nameLower = rawName.toLowerCase();
  const isClaimingAdminName = nameLower === ADMIN_NAME.toLowerCase();

  // Bloqueio de sigla secreta: só vale ANTES do posto de admin ser reivindicado
  // pela primeira vez. Depois disso, o nome exato já está protegido pelo
  // código automático abaixo, então outros jogadores podem ter "dmf" em
  // qualquer parte do nome sem problema.
  if (!isClaimingAdminName && !adminAssigned && nameLower.includes(BLOCKED_SUBSTRING)) {
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }

  if (isClaimingAdminName) {
    if (!adminAssigned) {
      // Primeira vez que alguém reivindica esse nome: essa conexão vira o
      // admin, e o servidor gera sozinho um código que o navegador dela vai
      // guardar pra ser reconhecida automaticamente nas próximas vezes.
      adminAssigned = true;
      adminToken = crypto.randomBytes(24).toString('hex');
      adminSocket = ws;
      ws.__isAdmin = true;
      return finishLogin(ws, ADMIN_NAME, 'admin');
    }

    // Já tem admin reivindicado: só entra quem apresentar o código certo,
    // que o navegador do admin manda sozinho (sem precisar digitar nada).
    if (msg.adminToken && msg.adminToken === adminToken) {
      if (adminSocket && adminSocket !== ws) {
        try { adminSocket.close(); } catch (e) {}
        players.delete(adminSocket);
      }
      adminSocket = ws;
      ws.__isAdmin = true;
      return finishLogin(ws, ADMIN_NAME, 'admin');
    }

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

// ---------------------------------------------------------------------------
// RECUPERAÇÃO DE ADMIN POR FRASE — só funciona se o admin autorizou a troca
// de dispositivo antes (pelo painel), e só reconhece a frase exata (o Artigo
// 2 da Constituição + o código pessoal). Uso único: some depois de usada.
// ---------------------------------------------------------------------------
function handleAdminRecover(ws, msg) {
  const now = Date.now();
  if (!deviceSwitchArmed || now - deviceSwitchArmedAt > DEVICE_SWITCH_WINDOW_MS) {
    deviceSwitchArmed = false;
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }
  if (normalizePhrase(msg.phrase) !== ADMIN_RECOVERY_PHRASE) {
    return safeSend(ws, { type: 'loginError', reason: 'Nome inválido ou indisponível. Por favor, escolha outro nome.' });
  }

  deviceSwitchArmed = false; // uso único, por segurança
  if (adminSocket && adminSocket !== ws) {
    try { adminSocket.close(); } catch (e) {}
    players.delete(adminSocket);
  }
  adminAssigned = true;
  adminSocket = ws;
  ws.__isAdmin = true;
  finishLogin(ws, ADMIN_NAME, 'admin');
}

// ---------------------------------------------------------------------------
// VERIFICA SE UM JOGADOR EXISTE (pro sistema de amigos) — "existe" quer dizer
// que esse nome já entrou no servidor desde a última vez que ele reiniciou.
// ---------------------------------------------------------------------------
function handleCheckPlayer(ws, msg) {
  const nameLower = (msg.name || '').toString().trim().toLowerCase();
  if (!nameLower) return;
  const entry = knownNames.get(nameLower);
  if (!entry) {
    return safeSend(ws, { type: 'checkPlayerResult', name: msg.name, exists: false });
  }
  safeSend(ws, {
    type: 'checkPlayerResult',
    name: entry.name,
    exists: true,
    online: entry.online,
    role: entry.role
  });
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
  knownNames.set(name.toLowerCase(), { name, role, online: true });

  safeSend(ws, {
    type: 'loginOk',
    id, name, role,
    isAdmin: role === 'admin',
    coins: player.coins,
    planesOwned: player.planesOwned,
    maintenanceMode,
    adminToken: role === 'admin' ? adminToken : undefined
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
// ---------------------------------------------------------------------------
function handleAdminCommand(ws, msg) {
  if (ws !== adminSocket || !ws.__isAdmin) return;

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

    case 'armDeviceSwitch':
      deviceSwitchArmed = true;
      deviceSwitchArmedAt = Date.now();
      safeSend(ws, { type: 'serverNotice', text: 'Troca de dispositivo autorizada por 10 minutos.' });
      break;

    case 'shutdown':
      broadcast({ type: 'serverNotice', text: 'Servidor sendo encerrado pelo Administrador' });
      setTimeout(() => {
        for (const client of wss.clients) { try { client.terminate(); } catch (e) {} }
        process.exit(0);
      }, 600);
      return;

    default:
      return;
  }

  broadcast({ type: 'playerList', players: publicPlayerList() });
}

console.log(`Servidor do simulador de voo rodando na porta ${PORT}`);
console.log('Admin: quem digitar paulodmf123 primeiro vira administrador automaticamente.');
