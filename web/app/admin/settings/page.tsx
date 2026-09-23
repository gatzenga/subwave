import type { Metadata } from 'next';
import SettingsPanel from '../../../components/admin/SettingsPanel';

export const metadata: Metadata = {
  title: 'Settings',
};

export default function AdminSettingsPage() {
  return <SettingsPanel />;
}
