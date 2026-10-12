import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from '@/components/ui/chart'
import { Line, LineChart, XAxis, YAxis, CartesianGrid } from 'recharts'
import { ListTodo, PlayCircle, Server, ServerCog } from 'lucide-react'
import { get, type DashboardData, type LogReport } from '@/lib/api'

const STATS = [
  { key: 'jobCount', label: '任务总数', icon: ListTodo },
  { key: 'runningJobs', label: '运行中任务', icon: PlayCircle },
  { key: 'groupCount', label: '执行器组', icon: Server },
  { key: 'onlineGroups', label: '在线执行器组', icon: ServerCog },
] as const

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [reports, setReports] = useState<LogReport[]>([])

  useEffect(() => {
    get<DashboardData>('/api/dashboard').then(setData).catch(() => undefined)
    get<LogReport[]>('/api/reports?days=7').then(setReports).catch(() => undefined)
  }, [])

  const chartData = [...reports]
    .filter((r) => r.trigger_day)
    .map((r) => ({
      day: String(r.trigger_day).slice(5, 10),
      成功: r.suc_count,
      失败: r.fail_count,
      运行中: r.running_count,
    }))

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((stat) => (
          <Card key={stat.key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
              <stat.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {data ? (
                <div className="text-2xl font-bold">{data[stat.key]}</div>
              ) : (
                <Skeleton className="h-8 w-16" />
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>近 7 天调度报表</CardTitle>
            <CardDescription>每日成功 / 失败 / 运行中数量</CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length > 0 ? (
              <ChartContainer
                config={{
                  成功: { label: '成功', color: 'var(--chart-2)' },
                  失败: { label: '失败', color: 'var(--chart-1)' },
                  运行中: { label: '运行中', color: 'var(--chart-3)' },
                }}
                className="h-[280px] w-full"
              >
                <LineChart data={chartData} margin={{ left: 0, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line dataKey="成功" type="monotone" stroke="var(--color-成功)" strokeWidth={2} dot={false} />
                  <Line dataKey="失败" type="monotone" stroke="var(--color-失败)" strokeWidth={2} dot={false} />
                  <Line dataKey="运行中" type="monotone" stroke="var(--color-运行中)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                暂无报表数据（每分钟聚合一次）
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>今日概览</CardTitle>
            <CardDescription>当天调度执行情况</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data ? (
              <>
                <Row label="成功" value={data.today.suc} className="text-chart-2" />
                <Row label="失败" value={data.today.fail} className="text-chart-1" />
                <Row label="运行中" value={data.today.running} className="text-chart-3" />
              </>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`font-semibold ${className ?? ''}`}>{value}</span>
    </div>
  )
}
