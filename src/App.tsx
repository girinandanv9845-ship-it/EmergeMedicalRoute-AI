import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { EmptyState } from './components/ui';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AssistantPage } from './pages/AssistantPage';
import { AuditPage } from './pages/AuditPage';
import { CaseDetailsPage, CaseLookupPage } from './pages/CaseDetailsPage';
import { IntakePage } from './pages/IntakePage';
import { OverviewPage } from './pages/OverviewPage';
import { PolicyPage } from './pages/PolicyPage';
import { QueuePage } from './pages/QueuePage';
import { SettingsPage } from './pages/SettingsPage';
import { TestLabPage } from './pages/TestLabPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/intake" element={<IntakePage />} />
        <Route path="/assistant" element={<AssistantPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/cases" element={<CaseLookupPage />} />
        <Route path="/cases/:id" element={<CaseDetailsPage />} />
        <Route path="/policy" element={<PolicyPage />} />
        <Route path="/tests" element={<TestLabPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/safety" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<EmptyState title="Page not found" description="Use the navigation to find what you need." />} />
      </Routes>
    </AppShell>
  );
}
