import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { BarChart3, ListTodo, ScrollText, Server, Clock, UsersRound, UserRound, LogOut, KeyRound } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { get, post, type SafeUser } from '@/lib/api'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import Jobs from '@/pages/Jobs'
import Logs from '@/pages/Logs'
import Groups from '@/pages/Groups'
import Users from '@/pages/Users'

const NAV_ITEMS = [
  { to: '/', label: '运行报表', icon: BarChart3 },
  { to: '/jobs', label: '任务管理', icon: ListTodo },
  { to: '/logs', label: '调度日志', icon: ScrollText },
  { to: '/groups', label: '执行器管理', icon: Server },
]

function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const onSubmit = async () => {
    try {
      await post('/api/auth/change-password', { oldPassword, newPassword })
      toast.success('密码已修改')
      onOpenChange(false)
      setOldPassword('')
      setNewPassword('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '修改失败')
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>修改后当前会话保持有效。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>旧密码</Label>
            <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>新密码（至少 6 位）</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void onSubmit()}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Layout({ user }: { user: SafeUser | null }) {
  const navigate = useNavigate()
  const [pwdOpen, setPwdOpen] = useState(false)
  const onLogout = async () => {
    await post('/api/auth/logout').catch(() => undefined)
    navigate('/login', { replace: true })
  }
  const navItems = user?.role === 1
    ? [...NAV_ITEMS, { to: '/users', label: '用户管理', icon: UsersRound }]
    : NAV_ITEMS
  return (
    <SidebarProvider>
      <Toaster richColors position="top-center" />
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Clock className="size-6 text-primary" />
            <div className="leading-tight">
              <div className="font-semibold">XXL-JOB Node</div>
              <div className="text-xs text-muted-foreground">分布式任务调度平台</div>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>调度中心</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={false}>
                      <NavLink to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm text-muted-foreground">xxl-job-node admin</span>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5">
                  <UserRound className="size-4" />
                  {user?.username ?? '-'}
                  {user?.role === 1 ? '（管理员）' : ''}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setPwdOpen(true)}>
                  <KeyRound /> 修改密码
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => void onLogout()}>
                  <LogOut /> 退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </SidebarInset>
      <ChangePasswordDialog open={pwdOpen} onOpenChange={setPwdOpen} />
    </SidebarProvider>
  )
}

export default function App() {
  const [user, setUser] = useState<SafeUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void get<SafeUser>('/api/auth/me')
      .then(setUser)
      .catch(() => {
        window.location.hash = '#/login'
      })
      .finally(() => setReady(true))
  }, [])

  if (!ready) return null
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout user={user} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/groups" element={<Groups />} />
        <Route path="/users" element={<Users />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
