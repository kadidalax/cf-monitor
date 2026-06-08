import React, { Suspense, lazy } from 'react';
import { Navigate, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { DisplayThemeProvider } from './contexts/DisplayThemeContext';
import { LiveDataProvider } from './contexts/LiveDataContext';
import Loading from './components/Loading';
import ErrorBoundary from './components/ErrorBoundary';

const Layout = lazy(() => import('./pages/Layout'));
const Index = lazy(() => import('./pages/Index'));
const Instance = lazy(() => import('./pages/Instance'));
const Login = lazy(() => import('./pages/Login'));
const NotFound = lazy(() => import('./pages/NotFound'));

const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const AdminClients = lazy(() => import('./pages/admin/Clients'));
const SettingsLayout = lazy(() => import('./pages/admin/SettingsLayout'));
const SettingsSite = lazy(() => import('./pages/admin/SettingsSite'));
const SettingsGeneral = lazy(() => import('./pages/admin/SettingsGeneral'));
const AdminPingTasks = lazy(() => import('./pages/admin/PingTasks'));
const AdminNotifications = lazy(() => import('./pages/admin/Notifications'));
const AdminLogs = lazy(() => import('./pages/admin/AuditLogs'));
const AdminAccount = lazy(() => import('./pages/admin/Account'));
const AdminAbout = lazy(() => import('./pages/admin/About'));

function LiveDataRoute({ children }: { children: React.ReactNode }) {
  return <LiveDataProvider>{children}</LiveDataProvider>;
}

export default function App() {
  return (
    <ThemeProvider>
      <DisplayThemeProvider>
        <AuthProvider>
          <ErrorBoundary>
            <Suspense fallback={<Loading fullScreen />}>
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<LiveDataRoute><Index /></LiveDataRoute>} />
                  <Route path="instance/:uuid" element={<LiveDataRoute><Instance /></LiveDataRoute>} />
                </Route>

                <Route path="/login" element={<Login />} />

                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<LiveDataRoute><AdminDashboard /></LiveDataRoute>} />
                  <Route path="clients" element={<AdminClients />} />
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<SettingsSite />} />
                    <Route path="site" element={<SettingsSite />} />
                    <Route path="notification" element={<Navigate to="/admin/notifications/settings" replace />} />
                    <Route path="general" element={<SettingsGeneral />} />
                  </Route>
                  <Route path="ping" element={<AdminPingTasks />} />
                  <Route path="notifications" element={<AdminNotifications />} />
                  <Route path="notifications/:tab" element={<AdminNotifications />} />
                  <Route path="notification" element={<AdminNotifications />} />
                  <Route path="notification/:tab" element={<AdminNotifications />} />
                  <Route path="logs" element={<AdminLogs />} />
                  <Route path="account" element={<AdminAccount />} />
                  <Route path="about" element={<AdminAbout />} />
                </Route>

                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
          <Toaster
            position="top-right"
            richColors
            closeButton
            duration={4000}
            style={{ fontFamily: 'inherit' }}
          />
        </AuthProvider>
      </DisplayThemeProvider>
    </ThemeProvider>
  );
}
