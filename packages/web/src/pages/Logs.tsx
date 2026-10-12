import { useCallback, useEffect, useState } from 'react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { toast, Toaster } from 'sonner'
import { get, post, type JobLog, type JobGroup, type PageResult } from '@/lib/api'
import { Search, FileText, Ban } from 'lucide-react'

interface LogContent {
  fromLineNum: number
  toLineNum: number
  logContent: string
  isEnd: boolean
}

export default function Logs() {
  const [rows, setRows] = useState<JobLog[]>([])
  const [total, setTotal] = useState(0)
  const [groups, setGroups] = useState<JobGroup[]>([])
  const [filter, setFilter] = useState({ jobGroup: '0', jobId: '', logStatus: '0', start: '', end: '' })

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<JobLog | null>(null)
  const [logContent, setLogContent] = useState<LogContent | null>(null)
  const [fromLine, setFromLine] = useState(1)
  const [autoScroll, setAutoScroll] = useState(true)

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: '1', size: '200' })
    if (filter.jobGroup !== '0') params.set('jobGroup', filter.jobGroup)
    if (filter.jobId) params.set('jobId', filter.jobId)
    if (filter.logStatus !== '0') params.set('logStatus', filter.logStatus)
    if (filter.start) params.set('start', filter.start)
    if (filter.end) params.set('end', filter.end)
    const r = await get<PageResult<JobLog>>(`/api/logs?${params}`)
    setRows(r.rows)
    setTotal(r.total)
  }, [filter])

  useEffect(() => {
    void load()
    void get<JobGroup[]>('/api/groups/all').then(setGroups)
  }, [load])

  // 详情打开后滚动读取执行日志（1.5s 轮询直到 isEnd）
  useEffect(() => {
    if (!detailOpen || !detail) return
    let stopped = false
    const tick = async () => {
      try {
        const data = await get<LogContent>(`/api/logs/${detail.id}/content?fromLineNum=${fromLine}`)
        if (stopped) return
        if (data.toLineNum > data.fromLineNum) {
          setLogContent(data)
          if (autoScroll && !data.isEnd) setFromLine(data.toLineNum + 1)
          else if (autoScroll && data.isEnd) setFromLine(data.toLineNum + 1)
        }
      } catch {
        // 忽略轮询错误
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [detailOpen, detail, fromLine, autoScroll])

  const openDetail = async (log: JobLog) => {
    setDetail(log)
    setFromLine(1)
    setLogContent(null)
    setAutoScroll(true)
    setDetailOpen(true)
  }

  const onKill = async () => {
    if (!detail) return
    try {
      await post(`/api/logs/${detail.id}/kill`)
      toast.success('终止指令已发送（运行中的任务将被取消）')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '终止失败')
    }
  }

  const statusBadge = (log: JobLog) => {
    if (log.trigger_code !== 200 && log.trigger_code !== 0) return <Badge variant="destructive">调度失败</Badge>
    if (log.handle_code === 0) return <Badge variant="outline" className="border-amber-500 text-amber-600">进行中</Badge>
    if (log.handle_code === 200) return <Badge className="bg-chart-2 text-white">成功</Badge>
    if (log.handle_code === 502) return <Badge variant="destructive">超时</Badge>
    return <Badge variant="destructive">失败</Badge>
  }

  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? String(id)

  return (
    <div className="space-y-4">
      <Toaster richColors position="top-center" />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">执行器</Label>
          <Select value={filter.jobGroup} onValueChange={(v) => setFilter({ ...filter, jobGroup: v })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">全部</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">任务 ID</Label>
          <Input
            className="w-28"
            value={filter.jobId}
            onChange={(e) => setFilter({ ...filter, jobId: e.target.value })}
            placeholder="ID"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">状态</Label>
          <Select value={filter.logStatus} onValueChange={(v) => setFilter({ ...filter, logStatus: v })}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">全部</SelectItem>
              <SelectItem value="1">成功</SelectItem>
              <SelectItem value="2">失败</SelectItem>
              <SelectItem value="3">进行中</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">开始日期</Label>
          <Input
            type="date"
            className="w-40"
            value={filter.start}
            onChange={(e) => setFilter({ ...filter, start: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">结束日期</Label>
          <Input
            type="date"
            className="w-40"
            value={filter.end}
            onChange={(e) => setFilter({ ...filter, end: e.target.value })}
          />
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <Search /> 搜索
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">日志 ID</TableHead>
              <TableHead>执行器</TableHead>
              <TableHead>任务</TableHead>
              <TableHead>分片</TableHead>
              <TableHead>调度时间</TableHead>
              <TableHead>调度结果</TableHead>
              <TableHead>执行结果</TableHead>
              <TableHead className="w-20 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="font-mono text-xs">{log.id}</TableCell>
                <TableCell className="text-xs">{groupName(log.job_group)}</TableCell>
                <TableCell className="text-xs">
                  {log.job_id} / {log.executor_handler ?? '-'}
                </TableCell>
                <TableCell className="font-mono text-xs">{log.executor_sharding_param ?? '-'}</TableCell>
                <TableCell className="text-xs">{log.trigger_time ?? '-'}</TableCell>
                <TableCell>
                  {log.trigger_code === 200 ? (
                    <Badge variant="outline">成功</Badge>
                  ) : (
                    <Badge variant="destructive">失败</Badge>
                  )}
                </TableCell>
                <TableCell>{statusBadge(log)}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" title="执行日志" onClick={() => void openDetail(log)}>
                    <FileText />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  暂无日志（共 {total} 条）
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[90vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>执行日志 #{detail?.id}</DialogTitle>
            <DialogDescription>
              任务 {detail?.job_id}（{detail?.executor_handler}） · {detail?.executor_address ?? '未调度到执行器'}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {statusBadge(detail)}
                  <span className="text-xs text-muted-foreground">
                    调度 {detail.trigger_time} · 回调 {detail.handle_time ?? '-'}
                  </span>
                </div>
                {detail.handle_code === 0 && (
                  <Button variant="destructive" size="sm" onClick={() => void onKill()}>
                    <Ban /> 终止任务
                  </Button>
                )}
              </div>

              <Tabs defaultValue="log">
                <TabsList>
                  <TabsTrigger value="log">滚动日志</TabsTrigger>
                  <TabsTrigger value="msg">调度 / 执行报告</TabsTrigger>
                </TabsList>
                <TabsContent value="log">
                  <ScrollArea className="h-72 rounded-md border bg-muted/30 p-3">
                    <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
                      {logContent?.logContent || '（等待日志输出...）'}
                    </pre>
                  </ScrollArea>
                  <p className="mt-1 text-xs text-muted-foreground">
                    行 {logContent?.fromLineNum ?? 1} - {logContent?.toLineNum ?? 1}
                    {logContent?.isEnd ? '（已到末尾，实时刷新中）' : '（读取中...）'}
                  </p>
                </TabsContent>
                <TabsContent value="msg">
                  <div className="space-y-2">
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">调度报告</p>
                      <ScrollArea className="h-28 rounded-md border bg-muted/30 p-3">
                        <pre className="font-mono text-xs whitespace-pre-wrap">
                          {(detail.trigger_msg ?? '').replace(/<br>/g, '\n')}
                        </pre>
                      </ScrollArea>
                    </div>
                    <Separator />
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">执行报告（回调）</p>
                      <ScrollArea className="h-28 rounded-md border bg-muted/30 p-3">
                        <pre className="font-mono text-xs whitespace-pre-wrap">
                          {detail.handle_msg ?? '（等待回调...）'}
                        </pre>
                      </ScrollArea>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
