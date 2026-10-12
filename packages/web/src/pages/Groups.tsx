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
import { toast, Toaster } from 'sonner'
import { get, post, put, del, type JobGroup, type PageResult } from '@/lib/api'
import { Plus, Search, Pencil, Trash2 } from 'lucide-react'

interface FormState {
  id?: number
  app_name: string
  name: string
  address_type: number
  address_list: string
  access_token: string
}

const EMPTY_FORM: FormState = {
  app_name: '',
  name: '',
  address_type: 0,
  address_list: '',
  access_token: 'default_token',
}

export default function Groups() {
  const [rows, setRows] = useState<JobGroup[]>([])
  const [total, setTotal] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const load = useCallback(async () => {
    const r = await get<PageResult<JobGroup>>(
      `/api/groups?page=1&size=200${keyword ? `&name=${encodeURIComponent(keyword)}` : ''}`,
    )
    setRows(r.rows)
    setTotal(r.total)
  }, [keyword])

  useEffect(() => {
    void load()
  }, [load])

  const onSave = async () => {
    try {
      if (form.id) {
        await put(`/api/groups/${form.id}`, form)
      } else {
        await post('/api/groups', form)
      }
      setDialogOpen(false)
      toast.success(form.id ? '执行器已更新' : '执行器已创建')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const onRemove = async (g: JobGroup) => {
    try {
      await del(`/api/groups/${g.id}`)
      toast.success(`执行器[${g.name}]已删除`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <Toaster richColors position="top-center" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Input
            placeholder="按名称搜索"
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
            setForm(EMPTY_FORM)
            setDialogOpen(true)
          }}
        >
          <Plus /> 新增执行器
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">ID</TableHead>
              <TableHead>AppName</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>注册方式</TableHead>
              <TableHead>OnLine 机器地址</TableHead>
              <TableHead>AccessToken</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((g) => (
              <TableRow key={g.id}>
                <TableCell>{g.id}</TableCell>
                <TableCell className="font-mono text-xs">{g.app_name}</TableCell>
                <TableCell>{g.name}</TableCell>
                <TableCell>
                  {g.address_type === 0 ? (
                    <Badge variant="secondary">自动注册</Badge>
                  ) : (
                    <Badge variant="outline">手动录入</Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-96 truncate font-mono text-xs">
                  {(g.address_list ?? '').split(',').filter(Boolean).join('\n') || (
                    <span className="text-muted-foreground">暂无在线机器</span>
                  )}
                </TableCell>
                <TableCell className="max-w-32 truncate font-mono text-xs">{g.access_token}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setForm({
                          id: g.id,
                          app_name: g.app_name,
                          name: g.name,
                          address_type: g.address_type,
                          address_list: g.address_list ?? '',
                          access_token: g.access_token ?? '',
                        })
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => void onRemove(g)}>
                      <Trash2 className="text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  暂无执行器（共 {total} 条）
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? '编辑执行器' : '新增执行器'}</DialogTitle>
            <DialogDescription>执行器以 AppName 为唯一标识，任务通过路由策略分发到注册机器。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>AppName</Label>
              <Input
                value={form.app_name}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
                placeholder="如 xxl-job-node-sample"
              />
            </div>
            <div className="space-y-2">
              <Label>名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>注册方式</Label>
              <Select
                value={String(form.address_type)}
                onValueChange={(v) => setForm({ ...form, address_type: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">自动注册</SelectItem>
                  <SelectItem value="1">手动录入</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.address_type === 1 && (
              <div className="space-y-2">
                <Label>机器地址列表（逗号分隔）</Label>
                <Textarea
                  value={form.address_list}
                  onChange={(e) => setForm({ ...form, address_list: e.target.value })}
                  placeholder="http://192.168.1.10:9999/,http://192.168.1.11:9999/"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>AccessToken（与执行器配置一致）</Label>
              <Input
                value={form.access_token}
                onChange={(e) => setForm({ ...form, access_token: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void onSave()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
