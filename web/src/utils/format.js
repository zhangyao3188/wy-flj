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

/** 今日成功按等级汇总文案，如 V4 2 · V5 3 */
export function formatTodaySuccessByLevel(byLevel, { countField = 'total' } = {}) {
  if (!byLevel || typeof byLevel !== 'object') return ''
  const keys = Object.keys(byLevel).sort((a, b) => {
    const na = levelRank(a)
    const nb = levelRank(b)
    if (na !== nb) return na - nb
    return String(a).localeCompare(String(b))
  })
  const parts = keys
    .map((lv) => {
      const entry = byLevel[lv]
      const n =
        typeof entry === 'number'
          ? entry
          : entry && entry[countField] != null
            ? Number(entry[countField])
            : entry && entry.total != null
              ? Number(entry.total)
              : 0
      return n > 0 ? `${lv} ${n}` : null
    })
    .filter(Boolean)
  return parts.join(' · ')
}

/** 单账号今日成功等级明细，如 V5×1 · V6×2 */
export function formatAccountTodayLevels(byLevel) {
  if (!byLevel || typeof byLevel !== 'object') return ''
  const keys = Object.keys(byLevel).sort((a, b) => {
    const na = levelRank(a)
    const nb = levelRank(b)
    if (na !== nb) return na - nb
    return String(a).localeCompare(String(b))
  })
  const parts = keys
    .map((lv) => {
      const entry = byLevel[lv]
      const n = entry && entry.total != null ? Number(entry.total) : 0
      return n > 0 ? `${lv}×${n}` : null
    })
    .filter(Boolean)
  return parts.join(' · ')
}
