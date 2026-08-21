import { apiJson } from './http'

export function createLoginSession(payload) {
  return apiJson('/api/login/session', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getLoginSession(token) {
  return apiJson(`/api/login/session/${token}`)
}

export function sendSessionInput(token, body) {
  return apiJson(`/api/login/session/${token}/input`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function extractSession(token, body = {}) {
  return apiJson(`/api/login/session/${token}/extract`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function previewCurl(curl) {
  return apiJson('/api/login/curl/preview', {
    method: 'POST',
    body: JSON.stringify({ curl }),
  })
}

export function importCurl(payload) {
  return apiJson('/api/login/curl', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function sessionFrameUrl(token) {
  return `/api/login/session/${token}/frame?t=${Date.now()}`
}
