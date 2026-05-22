require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
// ---------- Uploads setup ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
const cors = require('cors');
app.use(cors({
    origin: 'https://3-stakebingo-game.pages.dev', // or your actual static domain
    credentials: true
}));

// ---------- Supabase ----------
console.log('Connecting to Supabase...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
(async () => {
  const { error } = await supabase.from('users').select('count', { count: 'exact', head: true });
  if (error) console.error('❌ Supabase error:', error.message);
  else console.log('✅ Supabase connected');
})();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use('/uploads', express.static(uploadDir));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'bingo_mega_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none'
  }
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ---------- Audit Logger ----------
async function logAuditEvent({
  eventType,
  roomId = null,
  userId = 'system',
  ipAddress = null,
  details = {}
}) {
  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert({
        event_type: eventType,
        room_id: roomId,
        user_id: userId,
        ip_address: ipAddress,
        details
      });
    if (error) throw error;
  } catch (err) {
    console.error(`[AUDIT FAIL] ${eventType} (user ${userId}):`, err.message);
  }
}

const Audit = {
  depositInitiated(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_INITIATED', userId, ipAddress: ip, details: data }); },
  depositCompleted(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_COMPLETED', userId, ipAddress: ip, details: data }); },
  depositFailed(userId, ip, data) { return logAuditEvent({ eventType: 'DEPOSIT_FAILED', userId, ipAddress: ip, details: data }); },
  withdrawalRequested(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_REQUESTED', userId, ipAddress: ip, details: data }); },
  withdrawalCompleted(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_COMPLETED', userId, ipAddress: ip, details: data }); },
  withdrawalRejected(userId, ip, data) { return logAuditEvent({ eventType: 'WITHDRAWAL_REJECTED', userId, ipAddress: ip, details: data }); },
  bingoCalled(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'BINGO_CALLED', roomId, userId, ipAddress: ip, details: data }); },
  bingoRejected(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'BINGO_REJECTED', roomId, userId, ipAddress: ip, details: data }); },
  winPaidOut(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'WIN_PAID_OUT', roomId, userId, ipAddress: ip, details: data }); },
  numberDrawn(roomId, data) { return logAuditEvent({ eventType: 'NUMBER_DRAWN', roomId, details: data }); },
  cardAssigned(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'CARD_ASSIGNED', roomId, userId, ipAddress: ip, details: data }); },
  adminAction(eventType, adminId, ip, details) { return logAuditEvent({ eventType, userId: adminId, ipAddress: ip, details }); },
  suspicious(roomId, userId, ip, data) { return logAuditEvent({ eventType: 'SUSPICIOUS_BEHAVIOR_DETECTED', roomId, userId, ipAddress: ip, details: data }); }
};

// ---------- Suspicious Activity Detector ----------
const winTimestamps = new Map();
const WINDOW_MS = 120_000;
const MAX_WINS_IN_WINDOW = 3;

function detectRapidWins(roomId, userId, ip) {
  if (!winTimestamps.has(userId)) winTimestamps.set(userId, []);
  const times = winTimestamps.get(userId);
  const now = Date.now();
  times.push(now);
  const recent = times.filter(t => now - t <= WINDOW_MS);
  winTimestamps.set(userId, recent);
  if (recent.length > MAX_WINS_IN_WINDOW) {
    Audit.suspicious(roomId, userId, ip, {
      detectionSource: 'win_velocity_check',
      reason: `More than ${MAX_WINS_IN_WINDOW} wins in ${WINDOW_MS/1000}s`,
      evidence: { recentWinCount: recent.length, windowMs: WINDOW_MS }
    });
    return true;
  }
  return false;
}

// ---------- Helper: Generate Bingo Card ----------
function generateCard() {
  const columns = [
    [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],
    [31,32,33,34,35,36,37,38,39,40,41,42,43,44,45],
    [46,47,48,49,50,51,52,53,54,55,56,57,58,59,60],
    [61,62,63,64,65,66,67,68,69,70,71,72,73,74,75]
  ];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const colNumbers = [];
    const available = [...columns[col]];
    for (let row = 0; row < 5; row++) {
      if (col === 2 && row === 2) { colNumbers.push('FREE'); }
      else { colNumbers.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]); }
    }
    card.push(colNumbers);
  }
  const transposed = [];
  for (let r = 0; r < 5; r++) transposed.push([card[0][r], card[1][r], card[2][r], card[3][r], card[4][r]]);
  return transposed;
}

// ---------- GameRoom Class (delayed fee deduction) ----------
class GameRoom {
  constructor(stake, io) {
    this.stake = stake;
    this.io = io;
    this.status = 'lobby';
    this.pendingPlayers = new Map();
    this.players = [];
    this.takenCardNumbers = new Set();
    this.calledNumbers = [];
    this.entryFee = stake;
    this.prizePool = 0;
    this.lobbyTimer = null;
    this.callInterval = null;
    this.lobbyEndTime = 0;
    this.cardSet = Array.from({ length: 100 }, () => generateCard());
    this.winners = [];
    this.bingoGraceTimeout = null;
    this.winningNumber = null;
    this.resetGame();
  }

  getRoomId() {
    return `stake_${this.stake}`;
  }

  resetGame() {
    this.status = 'lobby';
    this.pendingPlayers.clear();
    this.players = [];
    this.takenCardNumbers.clear();
    this.calledNumbers = [];
    this.prizePool = 0;
    this.winners = [];
    this.winningNumber = null;
    if (this.callInterval) clearInterval(this.callInterval);
    if (this.bingoGraceTimeout) clearTimeout(this.bingoGraceTimeout);
    this.bingoGraceTimeout = null;
    this.cardSet = Array.from({ length: 100 }, () => generateCard());
    this.lobbyEndTime = Date.now() + 30000;
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.lobbyTimer = setTimeout(() => this.startGame(), 30000);
    this.broadcastState();
  }

  broadcastState() {
    const state = this.getPublicState();
    this.io.to(this.getRoomId()).emit('roomState', state);
  }

  getPublicState() {
    return {
      stake: this.stake,
      status: this.status,
      playersCount: this.players.length,
      pendingCount: this.pendingPlayers.size,
      lobbyEndTime: this.lobbyEndTime,
      prizePool: this.prizePool,
      calledNumbersCount: this.calledNumbers.length,
      winners: this.winners.map(w => ({ username: w.username, telegramId: w.telegramId })),
      takenNumbers: Array.from(this.takenCardNumbers),
      calledNumbers: this.calledNumbers
    };
  }

  static getAllRoomsPublicState(rooms) {
    const state = {};
    for (const [stake, room] of Object.entries(rooms)) {
      state[stake] = room.getPublicState();
    }
    return state;
  }

  async addPendingPlayer(telegramId, username, ip) {
    if (this.status !== 'lobby') throw new Error('Game already started or ended');
    if (this.players.find(p => p.telegramId === telegramId) || this.pendingPlayers.has(telegramId)) {
      throw new Error('Already in this room');
    }
    this.pendingPlayers.set(telegramId, { username, ip });
    const socket = await getSocketByUserId(telegramId);
    if (socket) {
      socket.join(this.getRoomId());
      socket.emit('joinedRoom', {
        stake: this.stake,
        roomState: this.getPublicState(),
        calledNumbers: this.calledNumbers
      });
    }
    this.broadcastState();
    return true;
  }

  async selectCardNumber(telegramId, username, ip, cardNumber) {
    if (this.status !== 'lobby') throw new Error('Game already started or ended');
    if (!this.pendingPlayers.has(telegramId)) {
      throw new Error('You must join the room first');
    }
    if (this.players.find(p => p.telegramId === telegramId)) {
      throw new Error('You already selected a card');
    }
    const user = await loadUser(telegramId, username);
    if (user.balance < this.entryFee) {
      throw new Error(`Insufficient balance. Need ${this.entryFee} ETB.`);
    }
    user.balance -= this.entryFee;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', telegramId);
    users[telegramId].balance = user.balance;

    const num = parseInt(cardNumber);
    if (this.takenCardNumbers.has(num)) throw new Error('Card number already taken');
    this.takenCardNumbers.add(num);
    const card = this.cardSet[num-1];
    const player = {
      telegramId,
      username,
      card,
      markedNumbers: [],
      cardNumber: num,
      ip
    };
    this.players.push(player);
    this.pendingPlayers.delete(telegramId);
    Audit.cardAssigned(this.getRoomId(), telegramId, ip, { cardId: num.toString(), grid: card, stake: this.stake });

    const socket = await getSocketByUserId(telegramId);
    if (socket) {
      socket.emit('yourCard', card);
      socket.emit('markedNumbers', []);
      socket.emit('balanceUpdate', user.balance);
    }
    this.broadcastState();
    return player;
  }

  async removePlayer(telegramId) {
    if (this.pendingPlayers.has(telegramId)) {
      this.pendingPlayers.delete(telegramId);
    } else {
      const idx = this.players.findIndex(p => p.telegramId === telegramId);
      if (idx !== -1) {
        const player = this.players[idx];
        this.takenCardNumbers.delete(player.cardNumber);
        this.players.splice(idx, 1);
      }
    }
    const socket = await getSocketByUserId(telegramId);
    if (socket) socket.leave(this.getRoomId());
    this.broadcastState();
  }

  async changeCardNumber(telegramId, newCardNumber) {
    if (this.status !== 'lobby') throw new Error('Cannot change card after game starts');
    const player = this.players.find(p => p.telegramId === telegramId);
    if (!player) throw new Error('You have not selected a card yet');
    if (this.takenCardNumbers.has(newCardNumber)) throw new Error('Card number taken');
    this.takenCardNumbers.delete(player.cardNumber);
    player.cardNumber = newCardNumber;
    this.takenCardNumbers.add(newCardNumber);
    player.card = this.cardSet[newCardNumber-1];
    player.markedNumbers = [];
    const socket = await getSocketByUserId(telegramId);
    if (socket) {
      socket.emit('yourCard', player.card);
      socket.emit('markedNumbers', player.markedNumbers);
    }
    this.broadcastState();
  }

  async startGame() {
    if (this.status !== 'lobby') return;
    this.pendingPlayers.clear();
    if (this.players.length === 0) {
      this.resetGame();
      return;
    }
    this.status = 'running';
    this.prizePool = Math.floor(0.8 * (this.entryFee * this.players.length));
    this.calledNumbers = [];
    this.winningNumber = null;
    this.winners = [];
    this.broadcastState();
    this.io.to(this.getRoomId()).emit('gameStarted', {
      prizePool: this.prizePool,
      playersCount: this.players.length
    });
    this.startCalling();
  }

  startCalling() {
    if (this.callInterval) clearInterval(this.callInterval);
    this.callInterval = setInterval(() => {
      if (this.status !== 'running') {
        clearInterval(this.callInterval);
        return;
      }
      const allNums = Array.from({ length: 75 }, (_, i) => i+1);
      const available = allNums.filter(n => !this.calledNumbers.includes(n));
      if (available.length === 0) {
        clearInterval(this.callInterval);
        this.endGameWithWinners();
        return;
      }
      const number = available[Math.floor(Math.random() * available.length)];
      this.calledNumbers.push(number);

      // AUTO-MARK: Mark this number for every player who has it on their card
      for (const player of this.players) {
        if (!player.markedNumbers.includes(number) && player.card.flat().includes(number)) {
          player.markedNumbers.push(number);
          // Send private update to the player
          const socket = getSocketByUserId(player.telegramId);
          if (socket) socket.emit('markedNumbers', player.markedNumbers);
        }
      }

      this.io.to(this.getRoomId()).emit('numberCalled', { number, calledNumbers: this.calledNumbers });
      Audit.numberDrawn(this.getRoomId(), { drawnNumber: number, drawIndex: this.calledNumbers.length, stake: this.stake });
    }, 4000);
  }

  getLines(card) {
    const lines = [];
    // rows
    for (let r = 0; r < 5; r++) lines.push([card[r][0], card[r][1], card[r][2], card[r][3], card[r][4]]);
    // columns
    for (let c = 0; c < 5; c++) lines.push([card[0][c], card[1][c], card[2][c], card[3][c], card[4][c]]);
    // main diagonal
    lines.push([card[0][0], card[1][1], card[2][2], card[3][3], card[4][4]]);
    // anti-diagonal
    lines.push([card[0][4], card[1][3], card[2][2], card[3][1], card[4][0]]);
    // NOTE: Removed the non‑standard "four corners" line to avoid false wins
    return lines;
  }

  isLineComplete(line, marked) {
    return line.every(val => val === 'FREE' || marked.includes(val));
  }

  isBingoValidOnLastCall(card, marked, lastCalled) {
    if (lastCalled === null) return false;
    // The last called number must be marked (or FREE)
    if (lastCalled !== 'FREE' && !marked.includes(lastCalled)) return false;
    const lines = this.getLines(card);
    for (const line of lines) {
      if (this.isLineComplete(line, marked) && line.includes(lastCalled)) {
        return true;
      }
    }
    return false;
  }

  async claimBingo(telegramId, username, ip) {
    if (this.status !== 'running') return { success: false, message: 'Game not running' };
    const player = this.players.find(p => p.telegramId === telegramId);
    if (!player) return { success: false, message: 'Not in game' };

    const lastCalled = this.calledNumbers.length > 0 ? this.calledNumbers[this.calledNumbers.length-1] : null;
    console.log(`[DEBUG] claimBingo by ${username} (${telegramId}) - lastCalled=${lastCalled}, markedCount=${player.markedNumbers.length}`);

    if (lastCalled === null) {
      console.log(`[DEBUG] claimBingo: lastCalled is null for user ${telegramId}`);
      Audit.bingoRejected(this.getRoomId(), telegramId, ip, { reason: 'no_numbers_drawn_yet', lastCalled });
      return { success: false, message: 'No numbers drawn yet' };
    }

    if (!this.isBingoValidOnLastCall(player.card, player.markedNumbers, lastCalled)) {
      console.log(`[DEBUG] claimBingo: invalid claim for user ${telegramId}. lastCalled=${lastCalled}, marked=${player.markedNumbers}`);
      Audit.bingoRejected(this.getRoomId(), telegramId, ip, { reason: 'invalid_bingo_call', lastCalled });
      return { success: false, message: 'Invalid Bingo claim' };
    }

    if (this.winners.find(w => w.telegramId === telegramId)) return { success: false, message: 'Already claimed' };
    if (this.winningNumber === null) this.winningNumber = lastCalled;
    this.winners.push({ telegramId, username });
    Audit.bingoCalled(this.getRoomId(), telegramId, ip, { cardId: player.cardNumber.toString(), cardGrid: player.card, calledNumber: lastCalled, stake: this.stake });

    if (!this.bingoGraceTimeout && this.winners.length === 1) {
      this.io.to(this.getRoomId()).emit('multipleBingoPossible', { message: 'Bingo claimed! Waiting for other potential winners...' });
      this.bingoGraceTimeout = setTimeout(() => this.endGameWithWinners(), 3000);
    }
    return { success: true };
  }

  async endGameWithWinners() {
    if (this.status !== 'running') return;
    this.status = 'ended';
    if (this.callInterval) clearInterval(this.callInterval);
    if (this.bingoGraceTimeout) clearTimeout(this.bingoGraceTimeout);
    this.bingoGraceTimeout = null;

    if (this.winners.length > 0) {
      const prizeEach = Math.floor(this.prizePool / this.winners.length);
      for (const w of this.winners) {
        const user = users[w.telegramId];
        if (user) {
          user.balance += prizeEach;
          await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', w.telegramId);
          const socket = await getSocketByUserId(w.telegramId);
          if (socket) socket.emit('balanceUpdate', user.balance);
          Audit.winPaidOut(this.getRoomId(), w.telegramId, null, {
            amount: prizeEach,
            currency: 'ETB',
            totalPrizePool: this.prizePool,
            totalWinners: this.winners.length,
            stake: this.stake
          });
          detectRapidWins(this.getRoomId(), w.telegramId, null);
        }
      }
      const totalEntryFees = this.players.length * this.entryFee;
      const houseProfit = totalEntryFees - this.prizePool;
      await supabase.from('game_rounds').insert({
        stake: this.stake,
        total_entry_fees: totalEntryFees,
        prize_pool: this.prizePool,
        house_profit: houseProfit,
        players_count: this.players.length,
        winners_count: this.winners.length
      });

      const ipCounts = {};
      this.winners.forEach(w => {
        const player = this.players.find(p => p.telegramId === w.telegramId);
        if (player && player.ip) ipCounts[player.ip] = (ipCounts[player.ip] || 0) + 1;
      });
      Object.entries(ipCounts).forEach(([ip, count]) => {
        if (count >= 3) {
          Audit.suspicious(this.getRoomId(), 'system', ip, {
            detectionSource: 'multiple_winners_same_ip',
            reason: `${count} winners from IP ${ip}`,
            evidence: { winners: this.winners.map(w => w.telegramId) }
          });
        }
      });

      const winnerNames = this.winners.map(w => w.username);
      this.io.to(this.getRoomId()).emit('gameEnded', {
        winner: winnerNames.length === 1 ? winnerNames[0] : `${winnerNames.length} winners`,
        winners: winnerNames,
        prizeEach,
        totalPrize: this.prizePool,
        winnerCount: this.winners.length,
        winningNumber: this.winningNumber
      });
    } else {
      this.io.to(this.getRoomId()).emit('gameEnded', { noWinner: true });
    }
    this.broadcastState();
    setTimeout(() => this.resetGame(), 5000);
  }

  markNumber(telegramId, number) {
    if (this.status !== 'running') return false;
    const player = this.players.find(p => p.telegramId === telegramId);
    if (!player) return false;
    if (number !== 'FREE' && (typeof number !== 'number' || number < 1 || number > 75)) return false;
    const flat = player.card.flat();
    if (!flat.includes(number)) return false;
    if (!this.calledNumbers.includes(number) && number !== 'FREE') return false;
    if (player.markedNumbers.includes(number)) return false;
    player.markedNumbers.push(number);
    // Send private update to the player
    const socket = getSocketByUserId(telegramId);
    if (socket) socket.emit('markedNumbers', player.markedNumbers);
    return true;
  }
}

// ---------- User cache ----------
const users = {};
async function loadUser(telegramId, username) {
  const id = String(telegramId);
  if (users[id]) return users[id];
  const { data } = await supabase.from('users').select('*').eq('telegram_id', id).maybeSingle();
  if (data) {
    users[id] = { id, username: data.username, balance: Number(data.balance) };
  } else {
    const newUser = { telegram_id: id, username: username || 'Player', balance: 10 };
    await supabase.from('users').insert(newUser);
    users[id] = { id, username: newUser.username, balance: 10 };
  }
  return users[id];
}

// ---------- Helper to get socket by user ID ----------
async function getSocketByUserId(userId) {
  const sockets = await io.fetchSockets();
  return sockets.find(s => s.userId === userId);
}

// ---------- Telegram verification ----------
function verifyTelegram(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return calculatedHash === hash;
}

// ---------- Express Endpoints ----------
app.get('/api/deposit-accounts', (req, res) => {
  res.json({
    telebirr: process.env.ADMIN_PHONE || '0924839730',
    cbebirr: process.env.CBE_ACCOUNT || '1000123456789',
    mpesa: process.env.MPESA_ACCOUNT || '251912345678'
  });
});

app.get('/api/admin-phone', (req, res) => { res.json({ phone: process.env.ADMIN_PHONE || '0924839730' }); });
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'audit.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/telegram-miniapp-auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData || !verifyTelegram(initData)) return res.status(403).json({ success: false });
  const params = new URLSearchParams(initData);
  const userData = JSON.parse(params.get('user'));
  const id = String(userData.id);
  const user = await loadUser(id, userData.first_name || userData.username);
  req.session.userId = id;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ success: false, error: 'Session save failed' });
    }
    res.json({ success: true, userId: id, username: user.username, balance: user.balance });
  });
});

app.post('/admin/add-balance', async (req, res) => {
  const { secret, telegramId, amount } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const strId = String(telegramId);
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = await loadUser(strId, 'unknown');
  user.balance += amt;
  await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', strId);
  Audit.adminAction('ADMIN_ADD_BALANCE', 'admin', req.ip, { targetUserId: strId, amount: amt, newBalance: user.balance });
  const sockets = await io.fetchSockets();
  const playerSocket = sockets.find(s => s.userId === strId);
  if (playerSocket) playerSocket.emit('balanceUpdate', user.balance);
  res.json({ success: true, newBalance: user.balance });
});

app.post('/api/request-deposit', upload.single('proof'), async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { phone, amount, payment_type } = req.body;
  const file = req.file;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!file) return res.status(400).json({ error: 'Proof image required' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(payment_type)) return res.status(400).json({ error: 'Invalid payment type' });
  const user = await loadUser(userId, null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const proofPath = `/uploads/${file.filename}`;
  const { data, error } = await supabase.from('deposit_requests').insert({
    telegram_id: userId, username: user.username, amount: amt, status: 'pending',
    phone: phone || null, payment_type, proof_path: proofPath
  }).select().single();
  if (error) { console.error('Deposit insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  Audit.depositInitiated(userId, req.ip, { transactionId: data.id.toString(), amount: amt, currency: 'ETB', method: payment_type });
  res.json({ success: true, requestId: data.id, message: `Deposit request of ${amt} ETB via ${payment_type} submitted.` });
});

app.get('/admin/deposits', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('deposit_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-deposit', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: reqData, error: fetchErr } = await supabase.from('deposit_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    await supabase.from('deposit_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.depositCompleted(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), providerRef: reqData.id.toString(), amount: reqData.amount, currency: 'ETB', method: reqData.payment_type || 'unknown' });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) { playerSocket.emit('balanceUpdate', user.balance); playerSocket.emit('depositStatus', { status: 'approved', amount: reqData.amount }); }
    res.json({ success: true, newBalance: user.balance });
  } else {
    await supabase.from('deposit_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.depositFailed(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, reason: 'rejected_by_admin' });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) playerSocket.emit('depositStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

app.post('/api/request-withdraw', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const { amount, phone, withdrawal_type, name } = req.body;
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['telebirr', 'cbebirr', 'mpesa'].includes(withdrawal_type)) return res.status(400).json({ error: 'Invalid withdrawal type' });
  const receiver = (phone || '').trim();
  if (!receiver || receiver.length < 10) return res.status(400).json({ error: 'Valid receiver phone/account required' });
  const receiverName = (name || '').trim();
  if (!receiverName) return res.status(400).json({ error: 'Account holder name is required' });
  const user = await loadUser(userId, null);
  if (!user || user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  const { data, error } = await supabase.from('withdrawal_requests').insert({
    telegram_id: userId, username: user.username, amount: amt, status: 'pending',
    phone_number: receiver, withdrawal_type, receiver_name: receiverName
  }).select().single();
  if (error) { console.error('Withdraw insert error:', error.message); return res.status(500).json({ error: 'Internal error' }); }
  Audit.withdrawalRequested(userId, req.ip, { transactionId: data.id.toString(), amount: amt, currency: 'ETB', method: withdrawal_type, receiver, name: receiverName });
  res.json({ success: true, requestId: data.id, message: `Withdrawal request of ${amt} ETB via ${withdrawal_type} to ${receiver} submitted.` });
});

app.get('/admin/withdrawals', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabase.from('withdrawal_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

app.post('/admin/process-withdrawal', async (req, res) => {
  const { secret, requestId, action } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: reqData, error: fetchErr } = await supabase.from('withdrawal_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !reqData) return res.status(404).json({ error: 'Request not found' });
  if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (action === 'approve') {
    const user = await loadUser(reqData.telegram_id, null);
    if (!user || user.balance < reqData.amount) return res.status(400).json({ error: 'Insufficient balance now' });
    user.balance -= reqData.amount;
    await supabase.from('users').update({ balance: user.balance }).eq('telegram_id', reqData.telegram_id);
    await supabase.from('withdrawal_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.withdrawalCompleted(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, currency: 'ETB', method: reqData.withdrawal_type || 'N/A', receiver: reqData.phone_number });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) { playerSocket.emit('balanceUpdate', user.balance); playerSocket.emit('withdrawStatus', { status: 'approved', amount: reqData.amount, phone: reqData.phone_number }); }
    res.json({ success: true, newBalance: user.balance });
  } else {
    await supabase.from('withdrawal_requests').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', requestId);
    Audit.withdrawalRejected(reqData.telegram_id, req.ip, { transactionId: requestId.toString(), amount: reqData.amount, reason: 'rejected_by_admin' });
    const sockets = await io.fetchSockets();
    const playerSocket = sockets.find(s => s.userId === reqData.telegram_id);
    if (playerSocket) playerSocket.emit('withdrawStatus', { status: 'rejected', amount: reqData.amount });
    res.json({ success: true });
  }
});

app.get('/admin/audit', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  const { roomId, userId, eventType, from, to, limit = 200 } = req.query;
  let query = supabase.from('audit_logs').select('*', { count: 'exact' });
  if (roomId) query = query.eq('room_id', roomId);
  if (userId) query = query.eq('user_id', userId);
  if (eventType) query = query.eq('event_type', eventType);
  if (from) query = query.gte('timestamp', from);
  if (to) query = query.lte('timestamp', to);
  query = query.order('timestamp', { ascending: false }).limit(Math.min(parseInt(limit), 1000));
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, logs: data, count });
});

app.get('/admin/audit-summary', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.AUDITOR_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  try {
    const { data: deposits, error: depErr } = await supabase.from('deposit_requests').select('amount').eq('status', 'approved');
    if (depErr) throw depErr;
    const { data: withdrawals, error: wdErr } = await supabase.from('withdrawal_requests').select('amount').eq('status', 'approved');
    if (wdErr) throw wdErr;
    const { data: rounds, error: rdErr } = await supabase.from('game_rounds').select('house_profit');
    if (rdErr) throw rdErr;
    const totalDeposits = deposits.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalWithdrawals = withdrawals.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalHouseProfit = rounds.reduce((sum, r) => sum + Number(r.house_profit), 0);
    res.json({ success: true, totalDeposits, totalWithdrawals, totalHouseProfit });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------- Socket.IO ----------
const rooms = {
  10: new GameRoom(10, io),
  20: new GameRoom(20, io),
  30: new GameRoom(30, io)
};

const userActiveRoom = new Map();

io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('Unauthorized'));
  socket.userId = socket.request.session.userId;
  socket.username = users[socket.userId]?.username || 'Player';
  next();
});

io.on('connection', async (socket) => {
  socket.emit('roomStates', GameRoom.getAllRoomsPublicState(rooms));
  socket.emit('balanceUpdate', users[socket.userId]?.balance || 0);

  const previousStake = userActiveRoom.get(socket.userId);
  if (previousStake && rooms[previousStake]) {
    const room = rooms[previousStake];
    const player = room.players.find(p => p.telegramId === socket.userId);
    if (player) {
      socket.join(room.getRoomId());
      socket.emit('joinedRoom', {
        stake: room.stake,
        card: player.card,
        markedNumbers: player.markedNumbers,
        roomState: room.getPublicState(),
        calledNumbers: room.calledNumbers
      });
    } else if (room.pendingPlayers.has(socket.userId)) {
      socket.join(room.getRoomId());
      socket.emit('joinedRoom', {
        stake: room.stake,
        roomState: room.getPublicState(),
        calledNumbers: room.calledNumbers
      });
    } else {
      userActiveRoom.delete(socket.userId);
    }
  }

  socket.on('selectStake', async ({ stake, preferredCardNumber }, callback) => {
    try {
      const stakeNum = parseInt(stake);
      if (![10,20,30].includes(stakeNum)) throw new Error('Invalid stake');
      const room = rooms[stakeNum];
      if (!room) throw new Error('Room not found');
      if (userActiveRoom.has(socket.userId)) {
        const currentStake = userActiveRoom.get(socket.userId);
        if (currentStake === stakeNum) throw new Error('Already in this room');
        else throw new Error('Already in another room. Leave first.');
      }
      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      await room.addPendingPlayer(socket.userId, socket.username, ip);
      userActiveRoom.set(socket.userId, stakeNum);
      if (callback) callback({ success: true });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
      else socket.emit('error', err.message);
    }
  });

  socket.on('leaveRoom', async (callback) => {
    const stake = userActiveRoom.get(socket.userId);
    if (stake && rooms[stake]) {
      await rooms[stake].removePlayer(socket.userId);
      userActiveRoom.delete(socket.userId);
      socket.leave(rooms[stake].getRoomId());
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, error: 'Not in any room' });
    }
  });

  socket.on('selectCardNumber', async ({ stake, cardNumber }, callback) => {
    const stakeNum = parseInt(stake);
    if (![10,20,30].includes(stakeNum)) return callback({ success: false, error: 'Invalid stake' });
    const room = rooms[stakeNum];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (userActiveRoom.get(socket.userId) !== stakeNum) return callback({ success: false, error: 'Not in this room' });
    try {
      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      const player = await room.selectCardNumber(socket.userId, socket.username, ip, cardNumber);
      callback({ success: true, player: { card: player.card, markedNumbers: player.markedNumbers } });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // NEW: event to change card number while in lobby
  socket.on('changeCardNumber', async ({ stake, cardNumber }, callback) => {
    const stakeNum = parseInt(stake);
    if (![10,20,30].includes(stakeNum)) return callback({ success: false, error: 'Invalid stake' });
    const room = rooms[stakeNum];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (userActiveRoom.get(socket.userId) !== stakeNum) return callback({ success: false, error: 'Not in this room' });
    try {
      await room.changeCardNumber(socket.userId, parseInt(cardNumber));
      const player = room.players.find(p => p.telegramId === socket.userId);
      if (player) {
        callback({ success: true, card: player.card, markedNumbers: player.markedNumbers });
      } else {
        callback({ success: false, error: 'Player not found' });
      }
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('markNumber', ({ stake, number }) => {
    const stakeNum = parseInt(stake);
    if (![10,20,30].includes(stakeNum)) return;
    const room = rooms[stakeNum];
    if (room && userActiveRoom.get(socket.userId) === stakeNum) {
      if (room.markNumber(socket.userId, number)) {
        // No broadcast – markedNumbers already sent privately inside markNumber()
      }
    }
  });

  socket.on('claimBingo', async ({ stake }, callback) => {
    const stakeNum = parseInt(stake);
    if (![10,20,30].includes(stakeNum)) return callback({ success: false, error: 'Invalid stake' });
    const room = rooms[stakeNum];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (userActiveRoom.get(socket.userId) !== stakeNum) return callback({ success: false, error: 'Not in this room' });
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const result = await room.claimBingo(socket.userId, socket.username, ip);
    callback(result);
  });

  socket.on('getBalance', async () => {
    const u = await loadUser(socket.userId, socket.username);
    socket.emit('balanceUpdate', u.balance);
  });

  socket.on('disconnect', () => {});
});

setInterval(() => {
  const allStates = GameRoom.getAllRoomsPublicState(rooms);
  io.emit('roomStates', allStates);
}, 2000);

app.use((err, req, res, next) => { console.error('Unhandled error:', err.message); res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Bingo server with 3 stake rooms on port ${PORT}`));
