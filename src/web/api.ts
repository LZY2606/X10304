export async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(path, init ? { ...init, headers: { 'content-type': 'application/json' } } : undefined);
  const body = await r.json();
  if (!r.ok && r.status !== 409) throw new Error(body.error ?? r.statusText);
  return { status: r.status, body };
}
export const get = (p: string) => api(p).then(r => r.body);
export const post = (p: string, b: unknown) => api(p, { method: 'POST', body: JSON.stringify(b) });
