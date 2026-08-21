export function fmtTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function levelRank(lv) {
  const m = String(lv || '').match(/(\d+)/)
  return m ? Number(m[1]) : 0
}

export function buildVipStats(list) {
  const vipStats = {}
  for (const a of list || []) {
    const levels = a.levels?.length ? a.levels : [{ vipLevel: a.vipLevel }]
    for (const lv of levels) {
      const key = lv.vipLevel || a.vipLevel || '未知'
      vipStats[key] = (vipStats[key] || 0) + 1
    }
  }
  return vipStats
}

export function vipStatEntries(vipStats) {
  return Object.entries(vipStats || {}).sort((a, b) => {
    const na = Number(String(a[0]).replace(/\D/g, ''))
    const nb = Number(String(b[0]).replace(/\D/g, ''))
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return String(a[0]).localeCompare(String(b[0]))
  })
}
