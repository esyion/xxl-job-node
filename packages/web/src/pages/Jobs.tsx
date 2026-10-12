import { useCallback, useEffect, useState } from 'react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast, Toaster } from 'sonner'
import { get, post, put, del, fmtTime, type JobInfo, type JobGroup, type PageResult, type Meta, type LogGlue } from '@/lib/api'
import { Plus, Search, MoreHorizontal, Pencil, Trash2, Play, Square, Zap, FileCode2 } from 'lucide-react'

interface FormState {
  id?: number
  job_group: number
  name: string
  author: string
  alarm_email: string
  schedule_type: string
  schedule_conf: string
  misfire_strategy: string
  executor_route_strategy: string
  executor_handler: string
  executor_param: string
  executor_block_strategy: string
  executor_timeout: number
  executor_fail_retry_count: number
  glue_type: string
  glue_source: string
  child_jobid: string
}

const EMPTY_FORM: FormState = {
  job_group: 0,
  name: '',
  author: '',
  alarm_email: '',
  schedule_type: 'CRON',
  schedule_conf: '0 * * * * ? *',
  misfire_strategy: 'DO_NOTHING',
  executor_route_strategy: 'FIRST',
  executor_handler: '',
  executor_param: '',
  executor_block_strategy: 'SERIAL_EXECUTION',
  executor_timeout: 0,
  executor_fail_retry_count: 0,
  glue_type: 'BEAN',
  glue_source: '',
  child_jobid: '',
}

export default function Jobs() {
  const [rows, setRows] = useState<JobInfo[] | null>(null)
  const [total, setTotal] = useState(0)
  const [groups, setGroups] = useState<JobGroup[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [keyword, setKeyword] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [nextTimes, setNextTimes] = useState<string[]>([])
  const [glueJob, setGlueJob] = useState<JobInfo | null>(null)

  const load = useCallback(async () => {
    const r = await get<PageResult<JobInfo>>(
      `/api/jobs?page=1&size=200${keyword ? `&name=${encodeURIComponent(keyword)}` : ''}`,
    )
    setRows(r.rows)
    setTotal(r.total)
  }, [keyword])

  useEffect(() => {
    void load()
    void get<JobGroup[]>('/api/groups/all').then(setGroups)
    void get<Meta>('/api/meta').then(setMeta)
  }, [load])

  // 预览下次触发时间
  useEffect(() => {
    if (!dialogOpen || (form.schedule_type !== 'CRON' && form.schedule_type !== 'FIX_RATE')) {
      setNextTimes([])
      return
    }
    const timer = setTimeout(() => {
      void get<number[]>(
        `/api/jobs/next-time?scheduleType=${form.schedule_type}&scheduleConf=${encodeURIComponent(form.schedule_conf)}&count=3`,
      )
        .then((times) => setNextTimes(times.map((t) => new Date(t).toLocaleString('zh-CN', { hour12: false }))))
        .catch(() => setNextTimes([]))
    }, 600)
    return () => clearTimeout(timer)
  }, [dialogOpen, form.schedule_type, form.schedule_conf])

  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? String(id)

  const onSave = async () => {
    try {
      if (form.id) {
        await put(`/api/jobs/${form.id}`, form)
      } else {
        await post('/api/jobs', form)
      }
      setDialogOpen(false)
      toast.success(form.id ? '任务已更新' : '任务已创建')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const onStart = async (job: JobInfo) => {
    try {
      await post(`/api/jobs/${job.id}/start`)
      toast.success(`任务[${job.name}]已启动`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '启动失败')
    }
  }

  const onStop = async (job: JobInfo) => {
    try {
      await post(`/api/jobs/${job.id}/stop`)
      toast.success(`任务[${job.name}]已停止`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '停止失败')
    }
  }

  const onTriggerOnce = async (job: JobInfo) => {
    try {
      await post(`/api/jobs/${job.id}/trigger`, {})
      toast.success(`任务[${job.name}]已触发一次，请在调度日志中查看`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '触发失败')
    }
  }

  const onRemove = async (job: JobInfo) => {
    try {
      await del(`/api/jobs/${job.id}`)
      toast.success(`任务[${job.name}]已删除`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const onEdit = (job: JobInfo) => {
    setForm({
      id: job.id,
      job_group: job.job_group,
      name: job.name,
      author: job.author ?? '',
      alarm_email: job.alarm_email ?? '',
      schedule_type: job.schedule_type,
      schedule_conf: job.schedule_conf ?? '',
      misfire_strategy: job.misfire_strategy,
      executor_route_strategy: job.executor_route_strategy ?? 'FIRST',
      executor_handler: job.executor_handler ?? '',
      executor_param: job.executor_param ?? '',
      executor_block_strategy: job.executor_block_strategy,
      executor_timeout: job.executor_timeout,
      executor_fail_retry_count: job.executor_fail_retry_count,
      glue_type: job.glue_type,
      glue_source: job.glue_type === 'BEAN' ? '' : job.glue_source ?? '',
      child_jobid: job.child_jobid ?? '',
    })
    setDialogOpen(true)
  }

  return (
    <div className="space-y-4">
      <Toaster richColors position="top-center" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Input
            placeholder="按任务描述搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="w-56"
          />
          <Button variant="outline" size="icon" onClick={() => void load()}>
            <Search />
          </Button>
        </div>
        <Button
          onClick={() => {
            setForm({ ...EMPTY_FORM, job_group: groups[0]?.id ?? 0 })
            setDialogOpen(true)
          }}
        >
          <Plus /> 新增任务
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">ID</TableHead>
              <TableHead>任务描述</TableHead>
              <TableHead>执行器</TableHead>
              <TableHead>调度类型</TableHead>
              <TableHead>Cron / 频率</TableHead>
              <TableHead>JobHandler</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>下次触发</TableHead>
              <TableHead className="w-20 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null && (
              <TableRow>
                <TableCell colSpan={9}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {rows?.map((job) => (
              <TableRow key={job.id}>
                <TableCell>{job.id}</TableCell>
                <TableCell className="font-medium">{job.name}</TableCell>
                <TableCell>{groupName(job.job_group)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{job.schedule_type}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {job.schedule_type === 'FIX_RATE' ? `${job.schedule_conf}s` : job.schedule_conf}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {job.glue_type === 'BEAN' ? (
                    job.executor_handler
                  ) : (
                    <Badge variant="secondary">{job.glue_type}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {job.trigger_status === 1 ? (
                    <Badge className="bg-chart-2 text-white">RUNNING</Badge>
                  ) : (
                    <Badge variant="secondary">STOP</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {job.trigger_status === 1 ? fmtTime(job.trigger_next_time) : '-'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {job.trigger_status === 1 ? (
                      <Button variant="ghost" size="icon" title="停止" onClick={() => void onStop(job)}>
                        <Square className="text-destructive" />
                      </Button>
                    ) : (
                      <Button variant="ghost" size="icon" title="启动" onClick={() => void onStart(job)}>
                        <Play className="text-chart-2" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" title="执行一次" onClick={() => void onTriggerOnce(job)}>
                      <Zap className="text-amber-500" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onEdit(job)}>
                          <Pencil /> 编辑
                        </DropdownMenuItem>
                        {job.glue_type !== 'BEAN' && (
                          <DropdownMenuItem onClick={() => setGlueJob(job)}>
                            <FileCode2 /> GLUE 源码{job.trigger_status === 1 ? '（运行中可热更）' : ''}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem variant="destructive" onClick={() => void onRemove(job)}>
                          <Trash2 /> 删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows?.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  暂无任务（共 {total} 条）
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? `编辑任务 #${form.id}` : '新增任务'}</DialogTitle>
            <DialogDescription>任务定义 = 调度（何时）+ 路由（去哪）+ 执行（怎么跑）。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>执行器</Label>
              <Select value={String(form.job_group)} onValueChange={(v) => setForm({ ...form, job_group: Number(v) })}>
                <SelectTrigger>
                  <SelectValue placeholder="选择执行器" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>任务描述</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>调度类型</Label>
              <Select value={form.schedule_type} onValueChange={(v) => setForm({ ...form, schedule_type: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(meta?.scheduleTypes ?? ['CRON']).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{form.schedule_type === 'FIX_RATE' ? '频率（秒）' : 'Cron 表达式'}</Label>
              <Input
                value={form.schedule_conf}
                onChange={(e) => setForm({ ...form, schedule_conf: e.target.value })}
                placeholder={form.schedule_type === 'FIX_RATE' ? '60' : '0 * * * * ? *'}
              />
              {nextTimes.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  近 3 次触发：{nextTimes.join(' / ')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>过期策略（misfire）</Label>
              <Select value={form.misfire_strategy} onValueChange={(v) => setForm({ ...form, misfire_strategy: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.misfireStrategies ?? []).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>路由策略</Label>
              <Select value={form.executor_route_strategy} onValueChange={(v) => setForm({ ...form, executor_route_strategy: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.routeStrategies ?? ['FIRST']).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>任务模式</Label>
              <Select value={form.glue_type} onValueChange={(v) => setForm({ ...form, glue_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.glueTypes ?? ['BEAN']).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.glue_type === 'BEAN' && (
              <div className="space-y-2">
                <Label>JobHandler</Label>
                <Input
                  value={form.executor_handler}
                  onChange={(e) => setForm({ ...form, executor_handler: e.target.value })}
                  placeholder="demoJobHandler"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>阻塞处理策略</Label>
              <Select value={form.executor_block_strategy} onValueChange={(v) => setForm({ ...form, executor_block_strategy: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meta?.blockStrategies ?? []).map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>超时时间（秒，0=不限）</Label>
              <Input
                type="number"
                value={form.executor_timeout}
                onChange={(e) => setForm({ ...form, executor_timeout: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>失败重试次数</Label>
              <Input
                type="number"
                value={form.executor_fail_retry_count}
                onChange={(e) => setForm({ ...form, executor_fail_retry_count: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>负责人</Label>
              <Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>报警邮件（可选）</Label>
              <Input value={form.alarm_email} onChange={(e) => setForm({ ...form, alarm_email: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>任务参数</Label>
              <Textarea
                value={form.executor_param}
                onChange={(e) => setForm({ ...form, executor_param: e.target.value })}
                placeholder="任意字符串，任务内通过 XxlJobHelper.getJobParam() 获取"
              />
            </div>
            {form.glue_type !== 'BEAN' && (
              <div className="space-y-2 sm:col-span-2">
                <Label>脚本源码（执行时落盘为临时文件后运行）</Label>
                <Textarea
                  value={form.glue_source}
                  onChange={(e) => setForm({ ...form, glue_source: e.target.value })}
                  className="min-h-40 font-mono text-xs"
                  placeholder={form.glue_type === 'GLUE_NODEJS' ? "console.log('hello', process.argv.slice(2));" : '#!/bin/bash\necho hello'}
                />
              </div>
            )}
            <div className="space-y-2 sm:col-span-2">
              <Label>子任务 ID（逗号分隔，本任务成功后级联触发）</Label>
              <Input value={form.child_jobid} onChange={(e) => setForm({ ...form, child_jobid: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => void onSave()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {glueJob && <GlueDialog job={glueJob} onClose={() => setGlueJob(null)} />}
    </div>
  )
}

/** GLUE 源码管理：运行中可热更（执行器按 glueUpdatetime 缓存失效），带版本历史与回滚 */
function GlueDialog({ job, onClose }: { job: JobInfo; onClose: () => void }) {
  const [source, setSource] = useState(job.glue_source ?? '')
  const [remark, setRemark] = useState('')
  const [versions, setVersions] = useState<LogGlue[]>([])

  useEffect(() => {
    void get<LogGlue[]>(`/api/jobs/${job.id}/glue`).then(setVersions).catch(() => undefined)
  }, [job.id])

  const onSave = async (glueSource?: string) => {
    try {
      await put(`/api/jobs/${job.id}/glue`, {
        glueSource: glueSource ?? source,
        glueRemark: (glueSource ?? source) === (job.glue_source ?? '') ? '回滚历史版本' : remark,
      })
      toast.success('源码已保存（版本已留档，运行中任务下次触发即生效）')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>GLUE 源码：{job.name}（{job.glue_type}）</DialogTitle>
          <DialogDescription>
            任务 {job.trigger_status === 1 ? '运行中 —— 保存后按下次触发生效（执行器端按更新时间缓存失效）' : '已停止'}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="edit">
          <TabsList>
            <TabsTrigger value="edit">源码编辑</TabsTrigger>
            <TabsTrigger value="history">版本历史（{versions.length}）</TabsTrigger>
          </TabsList>
          <TabsContent value="edit" className="space-y-3">
            <Textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="min-h-64 font-mono text-xs"
            />
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">版本备注</Label>
                <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="本次变更说明" />
              </div>
              <Button onClick={() => void onSave()}>保存并留档</Button>
            </div>
          </TabsContent>
          <TabsContent value="history">
            <ScrollArea className="h-72 rounded-md border">
              <div className="divide-y">
                {versions.map((v) => (
                  <div key={v.id} className="flex flex-col gap-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs">
                        <span className="font-medium">#{v.id}</span>{' '}
                        <span className="text-muted-foreground">{v.add_time}</span> — {v.glue_remark}
                      </div>
                      <Button variant="outline" size="sm" onClick={() => void onSave(v.glue_source ?? '')}>
                        回滚到此版本
                      </Button>
                    </div>
                    <pre className="max-h-24 overflow-y-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
                      {(v.glue_source ?? '').slice(0, 500)}
                    </pre>
                  </div>
                ))}
                {versions.length === 0 && (
                  <p className="p-6 text-center text-sm text-muted-foreground">暂无历史版本</p>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
