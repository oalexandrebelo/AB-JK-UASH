import {useEffect, useState, type ReactNode} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {ActionButton} from '@react-spectrum/s2/ActionButton';
import {SearchField} from '@react-spectrum/s2/SearchField';
import {StatusLight} from '@react-spectrum/s2/StatusLight';
import {SideNav, SideNavItem, SideNavItemContent, SideNavItemLink, SideNavSection, SideNavHeader, Text} from '@react-spectrum/s2/SideNav';
import type {User, StorageMode} from '../lib/api';
import {canManage} from '../lib/domain';
import {Brand} from './Brand';
import {EmptyState, fullWidth, Icon, Modal} from './ui';

export const navGroups = [
  {label: 'ATENDIMENTO', items: [{id: 'dashboard', label: 'Visão geral', icon: 'dashboard'}, {id: 'orders', label: 'Ordens de serviço', icon: 'orders'}, {id: 'appointments', label: 'Agenda', icon: 'calendar'}, {id: 'deliveries', label: 'Retirada e entrega', icon: 'vehicles'}, {id: 'customers', label: 'Clientes', icon: 'customers'}, {id: 'vehicles', label: 'Veículos', icon: 'vehicles'}, {id: 'checklist', label: 'Checklist e fotos', icon: 'checklist'}]},
  {label: 'GESTÃO', items: [{id: 'services', label: 'Serviços', icon: 'services'}, {id: 'products', label: 'Estoque', icon: 'products'}, {id: 'cash', label: 'Financeiro e caixa', icon: 'cash'}, {id: 'invoices', label: 'Pós-pago', icon: 'invoices'}, {id: 'fiscal', label: 'DPS / NFS-e', icon: 'fiscal'}, {id: 'packages', label: 'Pacotes', icon: 'packages'}, {id: 'employees', label: 'Equipe e comissões', icon: 'employees'}]},
  {label: 'CONTROLE', items: [{id: 'messages', label: 'Mensagens', icon: 'messages'}, {id: 'reports', label: 'Relatórios', icon: 'reports'}, {id: 'integrations', label: 'Integrações', icon: 'integrations'}, {id: 'migration', label: 'Migração de dados', icon: 'migration'}, {id: 'settings', label: 'Configurações', icon: 'settings'}]},
];
const managementPages = ['cash', 'invoices', 'fiscal', 'reports', 'integrations', 'migration'];
const roleNames = {admin: 'Administrador', manager: 'Gestor', operator: 'Operador', viewer: 'Consulta'};

export function Shell({user, storageMode, route, onLogout, children}: {user: User; storageMode: StorageMode; route: string; onLogout: () => void | Promise<void>; children: ReactNode}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [leaving, setLeaving] = useState(false);
  const groups = navGroups.map(group => ({...group, items: group.items.filter(item => (!managementPages.includes(item.id) || canManage(user.role)) && (item.id !== 'migration' || user.role === 'admin') && (item.id !== 'deliveries' || user.role !== 'viewer'))}));
  const allItems = groups.flatMap(group => group.items);
  const current = allItems.find(item => item.id === (route === 'payroll' ? 'employees' : route === 'package-sales' ? 'packages' : route.split('/')[0]));
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const matches = allItems.filter(item => normalize(item.label).includes(normalize(query.trim())));
  useEffect(() => {setMenuOpen(false); setSearchOpen(false); setQuery(''); document.title = `${current?.label || 'Operação'} · Lava Rápido JK`;}, [route, current?.label]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); setSearchOpen(value => !value);}};
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const mobileLinks = <div className="mobile-nav-groups">{groups.map(group => <section key={group.label}><h3>{group.label}</h3>{group.items.map(item => <a key={item.id} href={`#/${item.id}`} className={current?.id === item.id ? 'active' : ''} aria-current={current?.id === item.id ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon name={item.icon}/>{item.label}<Icon name="arrow" size={15}/></a>)}</section>)}</div>;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => {event.preventDefault(); document.getElementById('main-content')?.focus();}}>Ir para o conteúdo principal</a>
    <aside className="sidebar"><a className="brand" href="#/dashboard" aria-label="Lava Rápido JK, visão geral"><Brand/></a><div className="workspace-label"><span className="workspace-avatar"><Icon name="location" size={18}/></span><div><strong>Operação JK</strong><span>Rio Verde, GO</span></div><span className="workspace-tag">JK</span></div>
      <div className="sidebar-nav"><SideNav aria-label="Navegação principal" selectedRoute={`#/${current?.id || 'dashboard'}`}>{groups.map(group => <SideNavSection key={group.label}><SideNavHeader>{group.label}</SideNavHeader>{group.items.map(item => <SideNavItem key={item.id} id={item.id} href={`#/${item.id}`} textValue={item.label}><SideNavItemContent><SideNavItemLink><Text><span className="spectrum-nav-label"><Icon name={item.icon} size={18}/><span>{item.label}</span></span></Text></SideNavItemLink></SideNavItemContent></SideNavItem>)}</SideNavSection>)}</SideNav></div>
      <a className="sidebar-public-link" href="/" target="_blank" rel="noopener noreferrer"><Icon name="arrow-up-right" size={17}/><span>Visitar o site do JK</span></a><div className="sidebar-footer"><StatusLight variant="positive" size="S">{storageMode === 'postgres' ? 'Banco conectado' : 'Operação local'}</StatusLight></div>
    </aside>
    <div className="app-main"><header className="topbar"><div className="topbar-location"><span className="mobile-menu"><ActionButton aria-label="Abrir navegação" onPress={() => setMenuOpen(true)}><Icon name="menu"/></ActionButton></span><span className="topbar-product">Lava Rápido JK</span><span className="breadcrumb-slash">/</span><span className="topbar-current">{current?.label || 'Operação'}</span></div><div className="topbar-right"><span className="workspace-search"><ActionButton aria-label="Buscar área da operação. Atalho Control ou Command K" onPress={() => setSearchOpen(true)}><Icon name="search" size={17}/><span>Buscar</span><kbd>⌘ K</kbd></ActionButton></span><div className="user-avatar" aria-hidden="true">{user.name.split(' ').filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase()}</div><div className="user-info"><strong>{user.name}</strong><span>{roleNames[user.role]}</span></div><Button size="S" variant="secondary" fillStyle="outline" isPending={leaving} onPress={async () => {setLeaving(true); try {await onLogout();} finally {setLeaving(false);}}}>Sair</Button></div></header><main className="page-content" id="main-content" tabIndex={-1}>{children}</main><footer className="app-footer"><span>Lava Rápido JK <span className="footer-separator">·</span> Sua operação, em dia.</span><span>{new Date().toLocaleDateString('pt-BR', {timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'long', year: 'numeric'})}</span></footer></div>
    {menuOpen && <Modal title="Sua operação JK" onClose={() => setMenuOpen(false)}>{mobileLinks}</Modal>}
    {searchOpen && <Modal title="Para onde vamos?" onClose={() => setSearchOpen(false)}><SearchField label="Buscar uma área" value={query} onChange={setQuery} autoFocus styles={fullWidth}/><div className="command-results">{matches.length ? matches.map(item => <a href={`#/${item.id}`} key={item.id} onClick={() => {setSearchOpen(false); setQuery('');}}><Icon name={item.icon}/><span>{item.label}</span><Icon name="arrow" size={16}/></a>) : <EmptyState icon="search" title="Nenhuma área encontrada" description="Tente buscar por agenda, clientes, caixa ou outra parte da operação."/>}</div></Modal>}
  </div>;
}
