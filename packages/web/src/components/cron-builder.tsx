import { useEffect, useState } from 'react'
import cronstrue from 'cronstrue/i18n'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

/**
 * Cron 表达式可视化构建器（Quartz 7 域，含秒位）。
 * 五种预设模式 + 自定义高级输入，实时中文描述。
 * 周位使用英文缩写（MON..SUN）避免 Quartz(1=SUN) 与标准 cron(1=MON) 的数字语义歧义。
 */

type Mode = 'MINUTE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM'

const MODE_LABELS: Record<Mode, string> = {
  MINUTE: '每分钟',
  HOURLY: '每小时',
  DAILY: '每天',
  WEEKLY: '每周',
  MONTHLY: '每月',
  CUSTOM: '自定义',
}

const DOW_OPTIONS = [
  { value: 'MON', label: '周一' },
  { value: 'TUE', label: '周二' },
  { value: 'WED', label: '周三' },
  { value: 'THU', label: '周四' },
  { value: 'FRI', label: '周五' },
  { value: 'SAT', label: '周六' },
  { value: 'SUN', label: '周日' },
] as const

const DOW_CN: Record<string, string> = Object.fromEntries(
  DOW_OPTIONS.map((o) => [o.value, o.label]),
)

interface Parsed {
  mode: Mode
  minute: number
  hour: number
  dow: string
  dom: number
}

const pad = (n: number) => String(n).padStart(2, '0')

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** 从表达式反解析回模式与参数；无法匹配预设则落 CUSTOM */
function parseCron(value: string): Parsed {
  const p = value.trim().split(/\s+/)
  const base: Parsed = { mode: 'CUSTOM', minute: 0, hour: 0, dow: 'MON', dom: 1 }
  if (p.length !== 7 || p[0] !== '0') return base
  const [sec, min, hour, dom, mon, dow, year] = p
  void sec
  void mon
  void year
  if (min === '*' && hour === '*' && dom === '*' && dow === '?') return { ...base, mode: 'MINUTE' }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && dow === '?') {
    return { ...base, mode: 'HOURLY', minute: Number(min) }
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && dow === '?') {
    return { ...base, mode: 'DAILY', minute: Number(min), hour: Number(hour) }
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '?' && /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(dow)) {
    return { ...base, mode: 'WEEKLY', minute: Number(min), hour: Number(hour), dow }
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && dow === '?') {
    return { ...base, mode: 'MONTHLY', minute: Number(min), hour: Number(hour), dom: Number(dom) }
  }
  return base
}

function buildCron(p: Parsed): string {
  switch (p.mode) {
    case 'MINUTE': return '0 * * * * ? *'
    case 'HOURLY': return `0 ${p.minute} * * * ? *`
    case 'DAILY': return `0 ${p.minute} ${p.hour} * * ? *`
    case 'WEEKLY': return `0 ${p.minute} ${p.hour} ? * ${p.dow} *`
    case 'MONTHLY': return `0 ${p.minute} ${p.hour} ${p.dom} * ? *`
    default: return ''
  }
}

function describe(value: string, p: Parsed): string {
  switch (p.mode) {
    case 'MINUTE': return '每分钟的第 0 秒执行'
    case 'HOURLY': return `每小时的第 ${p.minute} 分执行`
    case 'DAILY': return `每天 ${pad(p.hour)}:${pad(p.minute)} 执行`
    case 'WEEKLY': return `${DOW_CN[p.dow] ?? p.dow} ${pad(p.hour)}:${pad(p.minute)} 执行`
    case 'MONTHLY': return `每月 ${p.dom} 号 ${pad(p.hour)}:${pad(p.minute)} 执行`
    default:
      try {
        // 7 域（含年）转 6 域、? 转 *，交 cronstrue 翻译
        const parts = value.trim().split(/\s+/)
        const expr = (parts.length === 7 ? parts.slice(0, 6) : parts).join(' ').replace(/\?/g, '*')
        return cronstrue.toString(expr, { locale: 'zh_CN' })
      } catch {
        return '表达式含义无法解析，请确认格式（秒 分 时 日 月 周 年）'
      }
  }
}

export default function CronBuilder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [parsed, setParsed] = useState<Parsed>(() => parseCron(value))
  const [custom, setCustom] = useState(() => (parseCron(value).mode === 'CUSTOM' ? value : ''))

  useEffect(() => {
    const p = parseCron(value)
    setParsed(p)
    if (p.mode === 'CUSTOM') setCustom(value)
  }, [value])

  const apply = (next: Partial<Parsed>) => {
    const p = { ...parsed, ...next }
    setParsed(p)
    onChange(buildCron(p))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={parsed.mode} onValueChange={(v) => {
          if (v === 'CUSTOM') {
            setParsed({ ...parsed, mode: 'CUSTOM' })
          } else {
            apply({ mode: v as Mode })
          }
        }}>
          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
              <SelectItem key={m} value={m}>{MODE_LABELS[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {parsed.mode === 'HOURLY' && (
          <Inline label="第">
            <Select value={String(parsed.minute)} onValueChange={(v) => apply({ minute: Number(v) })}>
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-60">
                {range(0, 59).map((n) => (
                  <SelectItem key={n} value={String(n)}>{n} 分</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Inline>
        )}

        {parsed.mode === 'DAILY' && <HourMinuteSelect parsed={parsed} apply={apply} />}

        {parsed.mode === 'WEEKLY' && (
          <>
            <Select value={parsed.dow} onValueChange={(v) => apply({ dow: v })}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DOW_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <HourMinuteSelect parsed={parsed} apply={apply} />
          </>
        )}

        {parsed.mode === 'MONTHLY' && (
          <>
            <Inline label="每月">
              <Select value={String(parsed.dom)} onValueChange={(v) => apply({ dom: Number(v) })}>
                <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {range(1, 31).map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} 号</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Inline>
            <HourMinuteSelect parsed={parsed} apply={apply} />
          </>
        )}

        {parsed.mode !== 'CUSTOM' && (
          <Badge variant="outline" className="font-mono text-xs">{value}</Badge>
        )}
      </div>

      {parsed.mode === 'CUSTOM' && (
        <Input
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value)
            onChange(e.target.value)
          }}
          placeholder="秒 分 时 日 月 周 年，如 0 0/30 9-18 * * ? *"
          className="font-mono"
        />
      )}

      <p className="text-xs text-muted-foreground">{describe(value, parsed)}</p>
    </div>
  )
}

function HourMinuteSelect({ parsed, apply }: { parsed: Parsed; apply: (p: Partial<Parsed>) => void }) {
  return (
    <Inline label="">
      <Select value={String(parsed.hour)} onValueChange={(v) => apply({ hour: Number(v) })}>
        <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-60">
          {range(0, 23).map((n) => (
            <SelectItem key={n} value={String(n)}>{pad(n)} 时</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-sm text-muted-foreground">:</span>
      <Select value={String(parsed.minute)} onValueChange={(v) => apply({ minute: Number(v) })}>
        <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-60">
          {range(0, 59).map((n) => (
            <SelectItem key={n} value={String(n)}>{pad(n)} 分</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Inline>
  )
}

function Inline({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
      {children}
    </div>
  )
}
