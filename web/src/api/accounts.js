import { apiJson } from './http'

export function listAccounts(all = true) {
  return apiJson(`/api/accounts${all ? '?all=1' : ''}`)
}

export function listSuccessLogs(day) {
  const q = day ? `?day=${encodeURIComponent(day)}` : ''
  return apiJson(`/api/seckill-success${q}`)
}

export function checkOnline() {
  return apiJson('/api/accounts/check-online', { method: 'POST' })
}

export function checkAccountOnline(id) {
  return apiJson(`/api/accounts/${id}/check-online`, { method: 'POST' })
}

export function syncAccount(id) {
  return apiJson(`/api/accounts/${id}/sync`, { method: 'POST' })
}

export function deleteAccount(id) {
  return apiJson(`/api/accounts/${id}/delete`, { method: 'POST' })
}

export function patchAccount(id, body) {
  return apiJson(`/api/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function addLevel(id, body) {
  return apiJson(`/api/accounts/${id}/levels`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function patchLevel(accountId, levelId, body) {
  return apiJson(`/api/accounts/${accountId}/levels/${levelId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteLevel(accountId, levelId) {
  return apiJson(`/api/accounts/${accountId}/levels/${levelId}/delete`, {
    method: 'POST',
  })
}
