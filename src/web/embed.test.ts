import { describe, expect, it } from 'vitest';
import { hostReply, hostRequest, parseCommand } from './embed.ts';

describe('FD-IOSCHART: the commands the iOS app may send the embedded chart', () => {
  it('takes the known ones, checked', () => {
    expect(parseCommand({ type: 'tf', tf: '4h' })).toEqual({ type: 'tf', tf: '4h' });
    expect(parseCommand({ type: 'picker' })).toEqual({ type: 'picker' });
    expect(parseCommand({ type: 'positions', on: false })).toEqual({ type: 'positions', on: false });
    expect(parseCommand({ type: 'reset', extra: 1 })).toEqual({ type: 'reset' });
    expect(parseCommand({ type: 'open', path: '/charts/s/AAPL' })).toEqual({ type: 'open', path: '/charts/s/AAPL' });
  });
  it('drops the unknown and the malformed', () => {
    expect(parseCommand({ type: 'eval', code: 'x' })).toBeNull();
    expect(parseCommand({ type: 'tf', tf: 'forever' })).toBeNull();
    expect(parseCommand({ type: 'positions', on: 'yes' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('picker')).toBeNull();
    expect(parseCommand({ type: 'open', path: '/settings' })).toBeNull();
    expect(parseCommand({ type: 'open', path: '/charts/../settings' })).toBeNull();
  });
});

describe('Sentiq.iOS FD-V3-S19: the native indicators sheets and the jump to a signal', () => {
  it('takes the indicators, the form edits and the jump, checked', () => {
    expect(parseCommand({ type: 'addStudy', id: 'RSI' })).toEqual({ type: 'addStudy', id: 'RSI' });
    expect(parseCommand({ type: 'favorite', id: 'slingshot' })).toEqual({ type: 'favorite', id: 'slingshot' });
    expect(parseCommand({ type: 'addPremium', key: 'lma' })).toEqual({ type: 'addPremium', key: 'lma' });
    expect(parseCommand({ type: 'formSet', key: 'in:length', value: 14 })).toEqual({ type: 'formSet', key: 'in:length', value: 14 });
    expect(parseCommand({ type: 'formSet', key: 'plot:p0:c:#FF0000', value: '#00FF0080' })).toEqual({ type: 'formSet', key: 'plot:p0:c:#FF0000', value: '#00FF0080' });
    // An emptied number field is null (the form reads NaN); a box ticked, a choice.
    expect(parseCommand({ type: 'formSet', key: 'in:length', value: null })).toEqual({ type: 'formSet', key: 'in:length', value: null });
    expect(parseCommand({ type: 'formSet', key: 'p:showLong', value: false })).toEqual({ type: 'formSet', key: 'p:showLong', value: false });
    expect(parseCommand({ type: 'formTab', tab: 'style' })).toEqual({ type: 'formTab', tab: 'style' });
    expect(parseCommand({ type: 'formSave' })).toEqual({ type: 'formSave' });
    expect(parseCommand({ type: 'formDefaults', x: 1 })).toEqual({ type: 'formDefaults' });
    expect(parseCommand({ type: 'formClose' })).toEqual({ type: 'formClose' });
    expect(parseCommand({ type: 'goto', time: 1_763_000_000_000 })).toEqual({ type: 'goto', time: 1_763_000_000_000 });
  });
  it('drops the malformed', () => {
    expect(parseCommand({ type: 'addStudy', id: '../x' })).toBeNull();
    expect(parseCommand({ type: 'addStudy' })).toBeNull();
    expect(parseCommand({ type: 'addPremium', key: 'rsi' })).toBeNull();
    expect(parseCommand({ type: 'formSet', key: '', value: 1 })).toBeNull();
    expect(parseCommand({ type: 'formSet', key: 'in:a\u0000', value: 1 })).toBeNull();
    expect(parseCommand({ type: 'formSet', key: 'x'.repeat(301), value: 1 })).toBeNull();
    expect(parseCommand({ type: 'formSet', key: 'in:x', value: { a: 1 } })).toBeNull();
    expect(parseCommand({ type: 'formSet', key: 'in:x', value: 'y'.repeat(301) })).toBeNull();
    expect(parseCommand({ type: 'formSet', key: 'in:x' })).toBeNull();
    expect(parseCommand({ type: 'formTab', tab: 'all' })).toBeNull();
    expect(parseCommand({ type: 'goto', time: '1' })).toBeNull();
    expect(parseCommand({ type: 'goto', time: Infinity })).toBeNull();
  });
});

describe('FD-IOSPAGES: requests the app answers (a passkey from iOS)', () => {
  it('the answer resolves its request; a cancel is the browser\'s NotAllowedError; unknown ids are ignored', async () => {
    const a = hostRequest<{ id: string }>('passkeyGet', { challenge: 'x' });
    const b = hostRequest('passkeyGet', { challenge: 'y' });
    const c = hostRequest('passkeyCreate', {});
    hostReply(999, true, 'nothing');
    hostReply(1, true, { id: 'cred' });
    hostReply(2, false, 'cancelled');
    hostReply(3, false, 'Passkey-ul nu a putut fi folosit');
    await expect(a).resolves.toEqual({ id: 'cred' });
    await expect(b).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect(c).rejects.toThrow('Passkey-ul nu a putut fi folosit');
  });
});
