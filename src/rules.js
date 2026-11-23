/**
 * rules.js — официальные правила BWF (счёт ралли, подача, линии, геймы).
 * Чистая логика без DOM и без физики, покрыта тестами tests/rules.test.mjs.
 *
 * Команды 0 и 1. В каждой команде игроки с индексами 0 (и 1 в паре).
 * m.teamSides[t] — знак x половины команды t (меняется между геймами).
 * Правая зона подачи стороны s имеет знак y = s.
 * В паре m.rightPlayer[t] — индекс игрока, стоящего в правой зоне
 * (подающая пара меняет зоны только при выигрыше очка на своей подаче).
 *
 * Публичный API (не менять сигнатуры):
 *   createMatch({mode, format, firstServer?}) -> Match
 *   servingInfo(m) -> ServeInfo
 *   awardRally(m, winnerTeam) -> {gameWon, matchWon, switchSides, interval, gameWinner}
 *   judgeLanding(m, pos, lastHitTeam, isServe, netHit, serveInfo?) -> {winner, reason}
 *   isInCourt(m, pos, side) -> boolean
 *   inServiceBox(m, serveInfo, pos) -> boolean
 *   serviceBox(m, serveInfo) -> {xMin,xMax,yMin,yMax}
 *   halfWidth(m) -> number
 */
import { COURT } from './config.js';

/**
 * @param {{mode:'singles'|'doubles', format:{games:number,points:number,cap:number}, firstServer?:number}} o
 */
export function createMatch(o) {
  const format = o.format || { games: 1, points: 21, cap: 30 };
  const first = o.firstServer ?? 0;
  return {
    mode: o.mode || 'singles',
    format,
    score: [0, 0],
    games: [0, 0],
    gameScores: [],          // [[a,b], ...] завершённых геймов
    gameIndex: 0,
    serverTeam: first,
    teamSides: [-1, 1],
    rightPlayer: [0, 0],
    intervalDone: false,
    over: false,
    winner: null,
    rallies: 0,
  };
}

export function halfWidth(m) {
  return m.mode === 'doubles' ? COURT.HALF_WIDTH_DOUBLES : COURT.HALF_WIDTH_SINGLES;
}

function occupant(m, team, court) {
  if (m.mode !== 'doubles') return 0;
  return court === 'right' ? m.rightPlayer[team] : 1 - m.rightPlayer[team];
}

/**
 * @typedef {{serverTeam:number, serverIdx:number, receiverTeam:number, receiverIdx:number,
 *   court:'right'|'left', serverSide:number, receiverSide:number,
 *   serverPos:{x:number,y:number}, receiverPos:{x:number,y:number}}} ServeInfo
 */
export function servingInfo(m) {
  const st = m.serverTeam, rt = 1 - st;
  const court = m.score[st] % 2 === 0 ? 'right' : 'left';
  const ss = m.teamSides[st], rs = m.teamSides[rt];
  const ySignS = court === 'right' ? ss : -ss;
  const ySignR = court === 'right' ? rs : -rs;
  const doubles = m.mode === 'doubles';
  return {
    serverTeam: st,
    serverIdx: occupant(m, st, court),
    receiverTeam: rt,
    receiverIdx: occupant(m, rt, court),
    court,
    serverSide: ss,
    receiverSide: rs,
    serverPos: { x: ss * (doubles ? 2.35 : 2.6), y: ySignS * (doubles ? 0.45 : 0.6) },
    receiverPos: { x: rs * (doubles ? 2.6 : 3.2), y: ySignR * (doubles ? 0.9 : 0.85) },
  };
}

/** Зона приёма подачи в мировых координатах. */
export function serviceBox(m, s) {
  const r = s.receiverSide;
  const long = m.mode === 'doubles' ? COURT.DOUBLES_LONG_SERVICE : COURT.HALF_LENGTH;
  const hw = halfWidth(m);
  const ySign = s.court === 'right' ? r : -r;
  const xs = [r * COURT.SHORT_SERVICE, r * long];
  const ys = [0, ySign * hw];
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
}

export function inServiceBox(m, s, pos) {
  const b = serviceBox(m, s);
  return pos.x >= b.xMin && pos.x <= b.xMax && pos.y >= b.yMin && pos.y <= b.yMax;
}

/** В пределах корта стороны side в розыгрыше (линии — «в корте»). */
export function isInCourt(m, pos, side) {
  if (Math.sign(pos.x) !== side && pos.x !== 0) return false;
  return Math.abs(pos.x) <= COURT.HALF_LENGTH && Math.abs(pos.y) <= halfWidth(m);
}

/**
 * Решение по приземлению волана.
 * @returns {{winner:number, reason:'in'|'out'|'net'|'serveFault'}}
 */
export function judgeLanding(m, pos, lastHitTeam, isServe, netHit, serveInfo) {
  const other = 1 - lastHitTeam;
  if (netHit) return { winner: other, reason: 'net' };
  const targetSide = m.teamSides[other];
  if (isServe) {
    const s = serveInfo || servingInfo(m);
    return inServiceBox(m, s, pos) ? { winner: lastHitTeam, reason: 'in' } : { winner: other, reason: 'serveFault' };
  }
  return isInCourt(m, pos, targetSide) ? { winner: lastHitTeam, reason: 'in' } : { winner: other, reason: 'out' };
}

function gameWonBy(m) {
  const { points, cap } = m.format;
  for (const t of [0, 1]) {
    const a = m.score[t], b = m.score[1 - t];
    if (a >= cap) return t;
    if (a >= points && a - b >= 2) return t;
  }
  return -1;
}

/** Засчитать розыгрыш команде winnerTeam. */
export function awardRally(m, winnerTeam) {
  const res = { gameWon: false, matchWon: false, switchSides: false, interval: false, gameWinner: -1 };
  if (m.over) return res;
  m.rallies++;
  const servingWon = winnerTeam === m.serverTeam;
  m.score[winnerTeam]++;
  if (servingWon) {
    // Подающая пара меняется зонами.
    if (m.mode === 'doubles') m.rightPlayer[winnerTeam] = 1 - m.rightPlayer[winnerTeam];
  } else {
    m.serverTeam = winnerTeam;
  }
  const gw = gameWonBy(m);
  if (gw >= 0) {
    res.gameWon = true; res.gameWinner = gw;
    m.games[gw]++;
    m.gameScores.push([m.score[0], m.score[1]]);
    const need = Math.ceil(m.format.games / 2);
    if (m.games[gw] >= need) {
      m.over = true; m.winner = gw; res.matchWon = true;
      return res;
    }
    // Новый гейм: смена сторон, победитель подаёт, счёт 0:0.
    m.gameIndex++;
    m.score = [0, 0];
    m.serverTeam = gw;
    m.rightPlayer = [0, 0];
    m.intervalDone = false;
    m.teamSides = [m.teamSides[1], m.teamSides[0]];
    res.switchSides = true;
    return res;
  }
  // Решающий гейм: смена сторон, когда лидер впервые набрал половину очков.
  const decider = m.format.games > 1 && m.gameIndex === m.format.games - 1;
  if (decider && !m.intervalDone && Math.max(...m.score) >= Math.ceil(m.format.points / 2)) {
    m.intervalDone = true;
    m.teamSides = [m.teamSides[1], m.teamSides[0]];
    res.switchSides = true; res.interval = true;
  }
  return res;
}
