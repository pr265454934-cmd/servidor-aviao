/**
 * client-multiplayer .js — Camada de multiplayer, loja e painel de ADM
 * ---------------------------------------------------------------------------
 * Carregado DEPOIS do script principal do flight-simulator.html (por isso
 * consegue enxergar diretamente `scene`, `plane`, `camera`, `flight`,
 * `resetFlight`, `THREE`, `PLANE_VARIANTS`, `window.rebuildPlaneAs` e
 * `window.spawnRemoteExplosion`, que são globais de script compartilhados
 * entre as duas tags <script> da página).
 *
 * Troque a linha abaixo pelo endereço real do seu servidor quando for hospedar
 * o server.js em algum lugar acessível pela internet.
 * ---------------------------------------------------------------------------
 */
const MP_SERVER_URL = 'wss://servidor-aviao-wex7.onrender.com

(function () {
  // ---------------------------------------------------------------------
  // ESTADO LOCAL DO CLIENTE
  // ---------------------------------------------------------------------
  const state = {
    socket: null,
    online: false,
    name: null,
    id: null,
    role: null,
    isAdmin: false,
    coins: 0,
    planesOwned: ['jato1'],
    equippedVariant: 'jato1',
    playersList: [],
    remotePlanes: new Map(), // id -> { group, targetPos, targetQuat, label }
    lastStateSentAt: 0
  };

  // ---------------------------------------------------------------------
  // ESTILOS (injetados aqui para manter tudo em um único arquivo)
  // ---------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #mpLoginOverlay {
      position:fixed; inset:0; z-index:100; background:rgba(0,0,0,0.75);
      display:flex; align-items:center; justify-content:center; flex-direction:column;
      font-family:'Courier New',Courier,monospace; color:#4dff85; text-align:center;
    }
    #mpLoginOverlay h1 { letter-spacing:3px; font-size:22px; margin-bottom:4px; }
    #mpLoginOverlay p.sub { color:#9fe6b3; font-size:11px; margin-bottom:18px; }
    #mpLoginOverlay input {
      font-family:inherit; background:#06140a; border:1px solid #2c5f36; color:#4dff85;
      padding:10px 12px; font-size:14px; letter-spacing:1px; width:240px; text-align:center; margin-bottom:14px;
    }
    #mpLoginOverlay .mpBtnRow { display:flex; gap:12px; }
    .mpBtn {
      font-family:inherit; background:rgba(6,14,8,0.85); border:1px solid #2c5f36; color:#4dff85;
      padding:11px 18px; font-size:13px; letter-spacing:1px; cursor:pointer;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
    }
    .mpBtn:hover { background:rgba(77,255,133,0.15); }
    .mpBtn:disabled { opacity:0.4; cursor:not-allowed; }
    #mpLoginError { color:#ff8f85; font-size:12px; margin-top:10px; min-height:16px; }
    #mpFriendsBtn { position:fixed; top:14px; right:14px; z-index:101; }

    #mpFriendsPanel, #mpShopPanel, #mpAdminPanel {
      position:fixed; inset:0; z-index:60; display:none; align-items:center; justify-content:center;
      background:rgba(0,0,0,0.6); font-family:'Courier New',Courier,monospace;
    }
    #mpFriendsPanel .inner, #mpShopPanel .inner, #mpAdminPanel .inner {
      background:rgba(6,14,8,0.96); border:1px solid #2c5f36; padding:18px; max-width:640px; width:92vw;
      max-height:82vh; overflow-y:auto; color:#4dff85;
    }
    .mpPanelHeader { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .mpPanelHeader h2 { font-size:15px; letter-spacing:2px; margin:0; }
    .mpClose { cursor:pointer; color:#ff8f85; font-size:13px; border:1px solid #7a2b2b; padding:4px 10px; }

    #mpFriendsPanel input {
      font-family:inherit; background:#06140a; border:1px solid #2c5f36; color:#4dff85;
      padding:8px; font-size:12px; width:70%; margin-right:8px;
    }
    .mpFriendItem { padding:6px 0; border-bottom:1px solid #163420; font-size:12px; color:#9fe6b3; }

    .mpShopGrid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .mpPlaneCard { border:1px solid #2c5f36; padding:12px; background:rgba(255,255,255,0.02); }
    .mpPlaneCard h3 { margin:0 0 6px 0; font-size:13px; color:#4dff85; }
    .mpPlaneCard .price { color:#ffb020; font-size:12px; margin-bottom:8px; }
    .mpPlaneSwatch { width:100%; height:28px; margin-bottom:8px; border:1px solid #163420; }

    #coinsGauge .value { color:#ffd24d; text-shadow:0 0 6px rgba(255,210,77,0.6); }

    #mpAdminPanel table { width:100%; border-collapse:collapse; font-size:11px; }
    #mpAdminPanel th, #mpAdminPanel td { border-bottom:1px solid #163420; padding:6px 4px; text-align:left; color:#9fe6b3; }
    #mpAdminPanel button { font-family:inherit; background:rgba(77,255,133,0.1); border:1px solid #2c5f36; color:#4dff85; font-size:10px; padding:4px 6px; margin:2px; cursor:pointer; }
    #mpAdminGlobal { margin-top:16px; display:flex; gap:10px; flex-wrap:wrap; }
    #mpAdminGlobal button.danger { border-color:#7a2b2b; color:#ff8f85; }

    #mpChatBox {
      position:fixed; left:50%; bottom:170px; transform:translateX(-50%); z-index:12;
      width:320px; display:none; flex-direction:column; font-family:'Courier New',Courier,monospace;
    }
    #mpChatLog { background:rgba(6,14,8,0.7); border:1px solid #2c5f36; height:90px; overflow-y:auto; font-size:11px; color:#9fe6b3; padding:6px; }
    #mpChatLog div { margin-bottom:2px; }
    #mpChatInput { background:rgba(6,14,8,0.9); border:1px solid #2c5f36; color:#4dff85; font-family:inherit; font-size:11px; padding:6px; }
    #mpServerNotice {
      position:fixed; top:40%; left:50%; transform:translate(-50%,-50%); z-index:70;
      background:rgba(80,0,0,0.85); border:1px solid #ff5a4d; color:#ffb0a8; padding:14px 22px;
      font-family:'Courier New',Courier,monospace; font-size:13px; letter-spacing:1px; display:none; text-align:center;
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------
  // TELA DE ENTRADA (nome obrigatório + Jogar Online / Jogar Sozinho)
  // ---------------------------------------------------------------------
  const loginOverlay = document.createElement('div');
  loginOverlay.id = 'mpLoginOverlay';
  loginOverlay.innerHTML = `
    <h1>SIMULADOR DE VOO — RECIFE</h1>
    <p class="sub">Escolha um nome de piloto para continuar</p>
    <input id="mpNameInput" type="text" maxlength="20" placeholder="Seu nome de piloto" autocomplete="off">
    <div class="mpBtnRow">
      <button class="mpBtn" id="mpPlayOnlineBtn">JOGAR ONLINE</button>
      <button class="mpBtn" id="mpPlaySoloBtn">JOGAR SOZINHO</button>
    </div>
    <div id="mpLoginError"></div>
  `;
  document.body.appendChild(loginOverlay);

  const friendsBtn = document.createElement('button');
  friendsBtn.id = 'mpFriendsBtn';
  friendsBtn.className = 'mpBtn';
  friendsBtn.textContent = '👥 FAZER AMIGOS';
  document.body.appendChild(friendsBtn);

  const errorEl = document.getElementById('mpLoginError');
  const nameInput = document.getElementById('mpNameInput');
  nameInput.value = localStorage.getItem('mp_lastName') || '';

  document.getElementById('mpPlaySoloBtn').addEventListener('click', () => {
    const name = validateNameLocally();
    if (!name) return;
    localStorage.setItem('mp_lastName', name);
    state.name = name;
    state.online = false;
    loadLocalProgress(name);
    finishEnteringGame();
  });

  document.getElementById('mpPlayOnlineBtn').addEventListener('click', () => {
    const name = validateNameLocally();
    if (!name) return;
    localStorage.setItem('mp_lastName', name);
    connectOnline(name);
  });

  function validateNameLocally() {
    const name = (nameInput.value || '').trim();
    errorEl.textContent = '';
    if (!name || name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_]+$/.test(name)) {
      errorEl.textContent = 'Nome inválido ou indisponível. Por favor, escolha outro nome.';
      return null;
    }
    // Mesmo filtro do servidor, checado também no cliente para feedback imediato
    // (o servidor sempre valida de novo — este é só um atalho de UX).
    if (name.toLowerCase() !== 'paulodmf123' && name.toLowerCase().includes('dmf')) {
      errorEl.textContent = 'Nome inválido ou indisponível. Por favor, escolha outro nome.';
      return null;
    }
    return name;
  }

  function loadLocalProgress(name) {
    const saved = JSON.parse(localStorage.getItem('mp_progress_' + name) || 'null');
    if (saved) {
      state.coins = saved.coins || 0;
      state.planesOwned = saved.planesOwned || ['jato1'];
    } else {
      state.coins = 0;
      state.planesOwned = ['jato1'];
    }
    state.isAdmin = false;
    state.role = 'solo';
  }
  function saveLocalProgress() {
    if (state.online) return; // progresso online vive no servidor, não local
    localStorage.setItem('mp_progress_' + state.name, JSON.stringify({ coins: state.coins, planesOwned: state.planesOwned }));
  }

  function finishEnteringGame() {
    loginOverlay.style.display = 'none';
    buildCoinsGauge();
    buildShopButton();
    if (state.isAdmin) buildAdminEntryPoint();
    // deixa o overlay original do jogo ("clique para ligar os motores") seguir seu fluxo normal
  }

  // ---------------------------------------------------------------------
  // CONEXÃO ONLINE (WebSocket)
  // ---------------------------------------------------------------------
  function connectOnline(name) {
    errorEl.textContent = 'Conectando...';
    let socket;
    try {
      socket = new WebSocket(MP_SERVER_URL);
    } catch (e) {
      errorEl.textContent = 'Não foi possível conectar ao servidor.';
      return;
    }
    state.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'login', name }));
    });

    socket.addEventListener('error', () => {
      errorEl.textContent = 'Servidor indisponível. Tente "Jogar Sozinho" ou verifique o endereço em client-multiplayer.js.';
    });

    socket.addEventListener('close', () => {
      if (state.online) showServerNotice('Conexão com o servidor encerrada.');
      state.online = false;
    });

    socket.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(msg);
    });
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'loginOk':
        state.online = true;
        state.name = msg.name;
        state.id = msg.id;
        state.role = msg.role;
        state.isAdmin = !!msg.isAdmin;
        state.coins = msg.coins;
        state.planesOwned = msg.planesOwned;
        errorEl.textContent = '';
        finishEnteringGame();
        break;

      case 'loginError':
        errorEl.textContent = msg.reason;
        try { state.socket.close(); } catch (e) {}
        break;

      case 'kicked':
        showServerNotice(msg.reason);
        setTimeout(() => location.reload(), 3500);
        break;

      case 'serverNotice':
        showServerNotice(msg.text);
        break;

      case 'playerList':
        state.playersList = msg.players;
        renderAdminPlayerTable();
        break;

      case 'playerJoined':
        addChatLine(`* ${msg.name} entrou no servidor`);
        break;

      case 'playerLeft':
        addChatLine('* um jogador saiu');
        removeRemotePlane(msg.id);
        break;

      case 'coinsUpdate':
        state.coins = msg.coins;
        updateCoinsGauge();
        addChatLine('+10 moedas por pouso bem-sucedido!');
        break;

      case 'buyOk':
        state.coins = msg.coins;
        state.planesOwned = msg.planesOwned;
        updateCoinsGauge();
        renderShopContents();
        break;

      case 'buyError':
        alert(msg.reason);
        break;

      case 'remoteState':
        updateRemotePlane(msg);
        break;

      case 'remoteExplosion':
        if (window.spawnRemoteExplosion) window.spawnRemoteExplosion({ x: msg.x, y: msg.y, z: msg.z });
        addChatLine(`💥 ${msg.by} caiu!`);
        break;

      case 'chat':
        addChatLine(`${msg.name}: ${msg.text}`);
        break;

      case 'chatBlocked':
        addChatLine('(você está silenciado)');
        break;

      default:
        break;
    }
  }

  function showServerNotice(text) {
    const el = document.getElementById('mpServerNotice') || createServerNoticeEl();
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(el.__t);
    el.__t = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }
  function createServerNoticeEl() {
    const el = document.createElement('div');
    el.id = 'mpServerNotice';
    document.body.appendChild(el);
    return el;
  }

  // ---------------------------------------------------------------------
  // AVIÕES REMOTOS (outros jogadores online)
  // ---------------------------------------------------------------------
  function updateRemotePlane(msg) {
    let entry = state.remotePlanes.get(msg.id);
    if (!entry) {
      const group = buildPlane('jato1');
      group.scale.setScalar(group.scale.x * 1); // mantém a escala padrão do modelo remoto
      scene.add(group);
      entry = { group, label: msg.name };
      state.remotePlanes.set(msg.id, entry);
    }
    entry.group.position.set(msg.x, msg.y, msg.z);
    entry.group.quaternion.set(msg.qx, msg.qy, msg.qz, msg.qw);
  }
  function removeRemotePlane(id) {
    const entry = state.remotePlanes.get(id);
    if (entry) { scene.remove(entry.group); state.remotePlanes.delete(id); }
  }

  // ---------------------------------------------------------------------
  // GANCHO CHAMADO PELO LOOP PRINCIPAL DO JOGO (window.MP.tick)
  // ---------------------------------------------------------------------
  window.MP = {
    tick(dt, localPlane) {
      if (!state.online || !state.socket || state.socket.readyState !== 1) return;
      const now = performance.now();
      if (now - state.lastStateSentAt < 60) return; // ~16 atualizações/seg
      state.lastStateSentAt = now;
      const p = localPlane.position, q = localPlane.quaternion;
      state.socket.send(JSON.stringify({
        type: 'state', x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w
      }));
    },
    reportLanded() {
      if (state.online && state.socket && state.socket.readyState === 1) {
        state.socket.send(JSON.stringify({ type: 'landed' }));
      } else if (!state.online && state.name) {
        state.coins += 10;
        updateCoinsGauge();
        saveLocalProgress();
      }
    },
    reportExplosion(position) {
      if (state.online && state.socket && state.socket.readyState === 1) {
        state.socket.send(JSON.stringify({ type: 'explosion', x: position.x, y: position.y, z: position.z }));
      }
    }
  };

  // ---------------------------------------------------------------------
  // HUD: MEDIDOR DE MOEDAS
  // ---------------------------------------------------------------------
  function buildCoinsGauge() {
    if (document.getElementById('coinsGauge')) return;
    const g = document.createElement('div');
    g.className = 'gauge';
    g.id = 'coinsGauge';
    g.innerHTML = `<div class="label">MOEDAS</div><div class="value"><span id="coinsVal">0</span></div>`;
    const gaugesEl = document.getElementById('hudGauges');
    if (gaugesEl) gaugesEl.appendChild(g);
    updateCoinsGauge();
  }
  function updateCoinsGauge() {
    const el = document.getElementById('coinsVal');
    if (el) el.textContent = state.coins;
  }

  // ---------------------------------------------------------------------
  // LOJA (4 aviões)
  // ---------------------------------------------------------------------
  function buildShopButton() {
    if (document.getElementById('mpShopBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'mpShopBtn';
    btn.className = 'mpBtn';
    btn.style.position = 'fixed';
    btn.style.left = '14px';
    btn.style.top = '54px';
    btn.style.zIndex = 12;
    btn.textContent = '🛒 LOJA';
    btn.addEventListener('click', openShop);
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'mpShopPanel';
    panel.innerHTML = `
      <div class="inner">
        <div class="mpPanelHeader"><h2>LOJA DE AVIÕES</h2><span class="mpClose" id="mpShopClose">FECHAR</span></div>
        <div class="mpShopGrid" id="mpShopGrid"></div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mpShopClose').addEventListener('click', () => { panel.style.display = 'none'; });
  }
  function openShop() {
    renderShopContents();
    document.getElementById('mpShopPanel').style.display = 'flex';
  }
  function renderShopContents() {
    const grid = document.getElementById('mpShopGrid');
    if (!grid || typeof PLANE_VARIANTS === 'undefined') return;
    grid.innerHTML = '';
    Object.keys(PLANE_VARIANTS).forEach((id) => {
      const v = PLANE_VARIANTS[id];
      const owned = state.planesOwned.includes(id) || state.isAdmin;
      const card = document.createElement('div');
      card.className = 'mpPlaneCard';
      const swatchColor = '#' + v.stripe.toString(16).padStart(6, '0');
      card.innerHTML = `
        <div class="mpPlaneSwatch" style="background:${swatchColor}"></div>
        <h3>${v.label}</h3>
        <div class="price">${id === 'jato1' ? 'Inicial' : (owned ? 'Comprado' : '200 moedas')}</div>
        <button class="mpBtn" data-id="${id}">${owned || id === 'jato1' ? 'EQUIPAR' : 'COMPRAR'}</button>
      `;
      grid.appendChild(card);
      card.querySelector('button').addEventListener('click', () => onShopAction(id, owned || id === 'jato1'));
    });
  }
  function onShopAction(id, owned) {
    if (owned) {
      state.equippedVariant = id;
      if (window.rebuildPlaneAs) window.rebuildPlaneAs(id);
      return;
    }
    if (state.online) {
      state.socket.send(JSON.stringify({ type: 'buyPlane', planeId: id }));
    } else {
      // Loja em modo "Jogar Sozinho": compra local usando o progresso salvo no navegador
      const price = 200;
      if (state.coins < price) return alert('Moedas insuficientes.');
      state.coins -= price;
      state.planesOwned.push(id);
      updateCoinsGauge();
      saveLocalProgress();
      renderShopContents();
    }
  }

  // ---------------------------------------------------------------------
  // PAINEL DE AMIGOS (lista local simples salva no navegador)
  // ---------------------------------------------------------------------
  const friendsPanel = document.createElement('div');
  friendsPanel.id = 'mpFriendsPanel';
  friendsPanel.innerHTML = `
    <div class="inner">
      <div class="mpPanelHeader"><h2>MEUS AMIGOS</h2><span class="mpClose" id="mpFriendsClose">FECHAR</span></div>
      <div>
        <input id="mpFriendInput" type="text" maxlength="20" placeholder="Nome do amigo">
        <button class="mpBtn" id="mpFriendAdd">ADICIONAR</button>
      </div>
      <div id="mpFriendList" style="margin-top:12px;"></div>
      <p style="color:#6a9c79; font-size:10px; margin-top:10px;">
        Lista salva só neste navegador — combine com seus amigos o nome de piloto que cada um vai usar ao entrar.
      </p>
    </div>
  `;
  document.body.appendChild(friendsPanel);
  friendsBtn.addEventListener('click', () => { renderFriendsList(); friendsPanel.style.display = 'flex'; });
  document.getElementById('mpFriendsClose').addEventListener('click', () => { friendsPanel.style.display = 'none'; });
  document.getElementById('mpFriendAdd').addEventListener('click', () => {
    const input = document.getElementById('mpFriendInput');
    const name = (input.value || '').trim();
    if (!name) return;
    const list = JSON.parse(localStorage.getItem('mp_friends') || '[]');
    if (!list.includes(name)) list.push(name);
    localStorage.setItem('mp_friends', JSON.stringify(list));
    input.value = '';
    renderFriendsList();
  });
  function renderFriendsList() {
    const list = JSON.parse(localStorage.getItem('mp_friends') || '[]');
    const el = document.getElementById('mpFriendList');
    el.innerHTML = list.length
      ? list.map((n) => `<div class="mpFriendItem">${n}</div>`).join('')
      : '<div class="mpFriendItem">Nenhum amigo adicionado ainda.</div>';
  }

  // ---------------------------------------------------------------------
  // CHAT (necessário para o mute/unmute do ADM terem efeito visível)
  // ---------------------------------------------------------------------
  const chatBox = document.createElement('div');
  chatBox.id = 'mpChatBox';
  chatBox.innerHTML = `<div id="mpChatLog"></div><input id="mpChatInput" placeholder="Aperte Enter para conversar...">`;
  document.body.appendChild(chatBox);
  const chatInput = document.getElementById('mpChatInput');
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // não deixa "W","A","S","D" digitados no chat pilotarem o avião
    if (e.key === 'Enter') {
      const text = chatInput.value.trim();
      if (text && state.online && state.socket) {
        state.socket.send(JSON.stringify({ type: 'chat', text }));
      }
      chatInput.value = '';
    }
  });
  function addChatLine(text) {
    const log = document.getElementById('mpChatLog');
    if (!log) return;
    const line = document.createElement('div');
    line.textContent = text;
    log.appendChild(line);
    while (log.children.length > 30) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    chatBox.style.display = 'flex';
  }

  // ---------------------------------------------------------------------
  // PAINEL DE ADM SECRETO (tecla X) — só existe/funciona para paulodmf123
  // ---------------------------------------------------------------------
  function buildAdminEntryPoint() {
    if (document.getElementById('mpAdminPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'mpAdminPanel';
    panel.innerHTML = `
      <div class="inner">
        <div class="mpPanelHeader"><h2>PAINEL DE ADMINISTRADOR</h2><span class="mpClose" id="mpAdminClose">FECHAR</span></div>
        <table>
          <thead><tr><th>Jogador</th><th>Cargo</th><th>Moedas</th><th>Ações</th></tr></thead>
          <tbody id="mpAdminTableBody"></tbody>
        </table>
        <div id="mpAdminGlobal">
          <button id="mpBtnMaintenance">ALTERNAR MODO MANUTENÇÃO</button>
          <input id="mpUnbanIp" placeholder="IP para desbanir" style="background:#06140a;border:1px solid #2c5f36;color:#4dff85;padding:4px;">
          <button id="mpBtnUnban">DESBANIR IP</button>
          <button id="mpBtnShutdown" class="danger">DESLIGAR SERVIDOR</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mpAdminClose').addEventListener('click', () => { panel.style.display = 'none'; });

    document.getElementById('mpBtnMaintenance').addEventListener('click', () => {
      sendAdminCommand({ action: 'toggleMaintenance' });
    });
    document.getElementById('mpBtnUnban').addEventListener('click', () => {
      const ip = document.getElementById('mpUnbanIp').value.trim();
      if (ip) sendAdminCommand({ action: 'unban', ip });
    });
    document.getElementById('mpBtnShutdown').addEventListener('click', () => {
      if (confirm('Tem certeza que deseja desligar o servidor para todos os jogadores?')) {
        sendAdminCommand({ action: 'shutdown' });
      }
    });
  }

  function sendAdminCommand(payload) {
    if (!state.online || !state.socket) return;
    state.socket.send(JSON.stringify(Object.assign({ type: 'adminCommand' }, payload)));
  }

  function renderAdminPlayerTable() {
    const body = document.getElementById('mpAdminTableBody');
    if (!body) return;
    body.innerHTML = state.playersList.map((p) => {
      const isAdminRow = p.role === 'admin';
      const actions = isAdminRow ? '<em>imune</em>' : `
        <button data-a="mute" data-id="${p.id}">Mute</button>
        <button data-a="unmute" data-id="${p.id}">Unmute</button>
        <button data-a="suspend" data-id="${p.id}">Suspender</button>
        <button data-a="banPermanent" data-id="${p.id}">Banir</button>
        <button data-a="promoteVice" data-id="${p.id}">Vice-ADM</button>
      `;
      return `<tr><td>${p.name}${p.muted ? ' 🔇' : ''}</td><td>${p.role}</td><td>${p.coins}</td><td>${actions}</td></tr>`;
    }).join('');

    body.querySelectorAll('button[data-a]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-a');
        const targetId = btn.getAttribute('data-id');
        if (action === 'suspend') {
          const days = parseInt(prompt('Suspender por quantos dias?', '1'), 10) || 1;
          sendAdminCommand({ action, targetId, days });
        } else {
          sendAdminCommand({ action, targetId });
        }
      });
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyX' && state.isAdmin) {
      const panel = document.getElementById('mpAdminPanel');
      if (panel) panel.style.display = (panel.style.display === 'flex') ? 'none' : 'flex';
    }
  });
})();
