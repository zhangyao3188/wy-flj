import { apiJson } from './http'

export function listPointsAccounts() {
  return apiJson('/api/points/identity-v/accounts')
}

export function fetchPointsProfile(id) {
  return apiJson(`/api/points/identity-v/accounts/${id}/profile`)
}

export function fetchPointsGoods(id) {
  return apiJson(`/api/points/identity-v/accounts/${id}/goods`)
}

export function submitPointsTask(id, body) {
  return apiJson(`/api/points/identity-v/accounts/${id}/task`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deletePointsTask(id, taskId, goodsId) {
  const body = {}
  if (taskId) body.taskId = taskId
  if (goodsId) body.goodsId = goodsId
  return apiJson(`/api/points/identity-v/accounts/${id}/task/delete`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listPointsTasks() {
  return apiJson('/api/points/identity-v/tasks')
}

export function listPointsSuccessLogs(day) {
  const q = day ? `?day=${encodeURIComponent(day)}` : ''
  return apiJson(`/api/points-seckill-success${q}`)
}
