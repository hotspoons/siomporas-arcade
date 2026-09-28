// The JSON-RPC peer's own tests, lifted with it from patapsco-remote so the port is held to the
// same behaviour the original is. If these pass, the lift did not change what it does.
import { describe, expect, it, vi } from 'vitest';
import { JsonRpcPeer, RpcError, type JsonRpcTransport } from '../src/agent/rpc';

function fake(): JsonRpcTransport & { sent: Record<string, unknown>[]; deliver(msg: unknown): void; drop(err?: Error): void } {
  let onMsg: (p: string) => void = () => {};
  let onClose: (e?: Error) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send: (p) => { sent.push(JSON.parse(p) as Record<string, unknown>); },
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onClose = cb; },
    close: () => {},
    deliver: (msg) => onMsg(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    drop: (err) => onClose(err),
  };
}

describe('JsonRpcPeer outbound', () => {
  it('resolves a request with its result', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    const p = peer.request<{ ok: boolean }>('do/thing', { a: 1 });
    expect(t.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'do/thing', params: { a: 1 } });
    t.deliver({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects with the code and message from an error response', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    const p = peer.request('do/thing');
    t.deliver({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'nope' } });
    await expect(p).rejects.toMatchObject({ code: -32001, message: 'nope' });
    await expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it('keeps concurrent requests apart', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    const a = peer.request<string>('a');
    const b = peer.request<string>('b');
    t.deliver({ jsonrpc: '2.0', id: 2, result: 'B' });
    t.deliver({ jsonrpc: '2.0', id: 1, result: 'A' });
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
  });

  it('sends a notification with no id', () => {
    const t = fake();
    new JsonRpcPeer(t).send('session/cancel', { sessionId: 's' });
    expect(t.sent[0]).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });
  });

  it('rejects everything in flight when the transport closes', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    const p = peer.request('slow');
    t.drop(new Error('socket reset'));
    await expect(p).rejects.toThrow(/slow: socket reset/);
  });

  it('refuses new requests after close', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    t.drop(new Error('gone'));
    await expect(peer.request('x')).rejects.toThrow(/gone/);
  });
});

describe('JsonRpcPeer inbound', () => {
  it('answers a request from its handler', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    peer.handle('ask', (params) => ({ echoed: params }));
    t.deliver({ jsonrpc: '2.0', id: 7, method: 'ask', params: { q: 1 } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: { echoed: { q: 1 } } });
  });

  it('replies method-not-found for an unregistered request', async () => {
    const t = fake();
    new JsonRpcPeer(t);
    t.deliver({ jsonrpc: '2.0', id: 1, method: 'mystery' });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0].error).toMatchObject({ code: -32601 });
  });

  it('turns a throwing handler into an error response', async () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    peer.handle('boom', () => { throw new Error('handler failed'); });
    t.deliver({ jsonrpc: '2.0', id: 3, method: 'boom' });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0].error).toMatchObject({ code: -32603, message: 'handler failed' });
  });

  it('dispatches a notification and sends nothing back', () => {
    const t = fake();
    const peer = new JsonRpcPeer(t);
    const seen: unknown[] = [];
    peer.notify('session/update', (p) => seen.push(p));
    t.deliver({ jsonrpc: '2.0', method: 'session/update', params: { x: 1 } });
    expect(seen).toEqual([{ x: 1 }]);
    expect(t.sent).toEqual([]);
  });

  it('reports an unparseable frame instead of throwing', () => {
    const t = fake();
    const errs: string[] = [];
    new JsonRpcPeer(t, (m) => errs.push(m));
    t.deliver('{not json');
    expect(errs[0]).toMatch(/unparseable/);
  });

  it('reports a response for an id it never issued', () => {
    const t = fake();
    const errs: string[] = [];
    new JsonRpcPeer(t, (m) => errs.push(m));
    t.deliver({ jsonrpc: '2.0', id: 99, result: 1 });
    expect(errs[0]).toMatch(/unknown id 99/);
  });

  it('does not let a throwing notification handler kill the peer', () => {
    const t = fake();
    const errs: string[] = [];
    const peer = new JsonRpcPeer(t, (m) => errs.push(m));
    peer.notify('n', () => { throw new Error('bad'); });
    t.deliver({ jsonrpc: '2.0', method: 'n' });
    expect(errs[0]).toMatch(/n threw: bad/);
  });
});
