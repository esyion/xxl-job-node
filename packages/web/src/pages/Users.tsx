import { useCallback, useEffect, useState } from 'react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { toast, Toaster } from 'sonner'
import { get, post, put, del, type SafeUser, type JobGroup } from '@/lib/api'
import { Plus, Pencil, Trash2 } from 'lucide-react'

interface FormState {
  id?: number
  username: string
  password: string
  role: number
  permission: Set<number>
}

const EMPTY_FORM: FormState = { username: '', password: '', role: 0, permission: new Set() }

export default function Users() {
  const [rows, setRows] = useState<SafeUser[]>([])
  const [groups, setGroups] = useState<JobGroup[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const load = useCallback(async () => {
    const users = await get<SafeUser[]>('/api/users').catch(() => [])
    setRows(users)
  }, [])

  useEffect(() => {
    void load()
    void get<JobGroup[]>('/api/groups/all').then(setGroups).catch(() => undefined)
  }, [load])

  const onSave = async () => {
    try {
      const body = {
        username: form.username,
        password: form.password,
        role: form.role,
        permission: [...form.permission].join(','),
      }
      if (form.id) {
        await put(`/api/users/${form.id}`, body)
      } else {
        await post('/api/users', body)
      }
      setDialogOpen(false)
      toast.success(form.id ? '用户已更新' : '用户已创建')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const onRemove = async (user: SafeUser) => {
    try {
      await del(`/api/users/${user.id}`)
      toast.success(`用户[${user.username}]已删除`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const togglePermission = (groupId: number, checked: boolean) => {
    const next = new Set(form.permission)
    if (checked) next.add(groupId)
    else next.delete(groupId)
    setForm({ ...form, permission: next })
  }

  return (
    <div className="space-y-4">
      <Toaster richColors position="top-center" />
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          普通用户只能访问其权限内执行器组下的任务与日志；管理员不受限。
        </p>
        <Button
          onClick={() => {
            setForm(EMPTY_FORM)
            setDialogOpen(true)
          }}
        >
          <Plus /> 新增用户
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">ID</TableHead>
              <TableHead>账号</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>权限（执行器组）</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((user) => (
              <TableRow key={user.id}>
                <TableCell>{user.id}</TableCell>
                <TableCell className="font-medium">{user.username}</TableCell>
                <TableCell>
                  {user.role === 1 ? (
                    <Badge>管理员</Badge>
                  ) : (
                    <Badge variant="secondary">普通用户</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {user.role === 1 ? (
                    <span className="text-muted-foreground">全部</span>
                  ) : (
                    (user.permission ?? '')
                      .split(',')
                      .filter(Boolean)
                      .map((id) => groups.find((g) => g.id === Number(id))?.name ?? `#${id}`)
                      .join('、') || <span className="text-muted-foreground">（无权限）</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setForm({
                          id: user.id,
                          username: user.username,
                          password: '',
                          role: user.role,
                          permission: new Set(
                            (user.permission ?? '').split(',').filter(Boolean).map(Number),
                          ),
                        })
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => void onRemove(user)}>
                      <Trash2 className="text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  暂无用户（仅管理员可见此页）
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? `编辑用户：${form.username}` : '新增用户'}</DialogTitle>
            <DialogDescription>密码使用 SHA-256 存储；普通用户需分配执行器组权限。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>账号</Label>
              <Input
                value={form.username}
                disabled={Boolean(form.id)}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{form.id ? '新密码（留空则不修改）' : '密码'}</Label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="至少 6 位"
              />
            </div>
            <div className="space-y-2">
              <Label>角色</Label>
              <Select value={String(form.role)} onValueChange={(v) => setForm({ ...form, role: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">普通用户</SelectItem>
                  <SelectItem value="1">管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.role === 0 && (
              <div className="space-y-2">
                <Label>权限（执行器组）</Label>
                <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md border p-3">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.permission.has(g.id)}
                        onCheckedChange={(checked) => togglePermission(g.id, checked === true)}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => void onSave()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
