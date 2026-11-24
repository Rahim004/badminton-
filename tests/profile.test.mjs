// Профиль, код друга, друзья, запись матчей, перенос профиля (src/profile).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/profile/index.js';

test('код друга: 6 символов без путаемых, детерминирован', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = P.friendCodeOf(i.toString(16).padStart(16, '0'));
    assert.equal(c.length, 6);
    assert.ok(!/[01OIL]/.test(c), c);
    assert.ok(P.isFriendCode(c));
    seen.add(c);
  }
  assert.ok(seen.size > 1990, 'почти без коллизий');
  assert.equal(P.friendCodeOf('abc12345'), P.friendCodeOf('abc12345'));
});

test('профиль создаётся, друзья добавляются и удаляются, матчи пишутся', () => {
  assert.equal(P.getProfile(), null);
  const me = P.saveProfile({ nick: '  Рахим  ', heroId: 'mira', color: '#2fb8ff' });
  assert.equal(me.nick, 'Рахим');
  assert.equal(me.heroId, 'mira');
  assert.equal(me.accent, '#0b4d80');
  assert.equal(me.friendCode, P.friendCodeOf(me.id));
  assert.equal(P.saveProfile({ nick: 'Рахим2' }).id, me.id, 'id не меняется');

  assert.equal(P.addFriend({ friendCode: me.friendCode }).ok, false, 'свой код нельзя');
  assert.equal(P.addFriend({ friendCode: 'O0O0O0' }).ok, false, 'путаемые символы');
  const fr = P.addFriend({ friendCode: 'k7 q4-mx' });
  assert.ok(fr.ok); assert.equal(fr.friend.friendCode, 'K7Q4MX');

  const opp = { id: 'ffeeddccbbaa0011', nick: 'Аня', heroId: 'aya', color: '#b388ff' };
  const r1 = P.recordMatch({ won: true, longestRally: 12, smashes: 3, online: true, opponents: [opp] });
  P.recordMatch({ won: false, longestRally: 20, smashes: 1, online: true, opponents: [opp] });
  assert.deepEqual(r1.records, []);
  const st = P.getProfile().stats;
  assert.deepEqual([st.matches, st.wins, st.longestRally, st.smashes, st.onlineMatches], [2, 1, 20, 4, 2]);
  const anya = P.listFriends()[0];
  assert.equal(anya.nick, 'Аня'); assert.equal(anya.wins, 1); assert.equal(anya.losses, 1); assert.ok(anya.auto);

  const code = P.exportProfile();
  assert.ok(code.startsWith('VOLAN1.'));
  assert.ok(P.removeFriend('K7Q4MX'));
  assert.equal(P.listFriends().length, 1);
  assert.equal(P.importProfile(code.slice(0, -3) + 'zz').ok, false, 'битый код');
  assert.equal(P.importProfile('hello').ok, false);
  const imp = P.importProfile(code);
  assert.ok(imp.ok);
  assert.equal(P.listFriends().length, 2, 'друзья вернулись из кода');
  assert.equal(P.getProfile().nick, 'Рахим2');
});
