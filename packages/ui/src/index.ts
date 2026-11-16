/**
 * Öffentliche Oberfläche des Design-Systems: alle geteilten UI-Bausteine.
 *
 * Die Design-Tokens liegen daneben in `tokens.css` (Einbindung per
 * `@import "@saas-instant/ui/tokens.css";`), die Schriften in `fonts.ts`
 * (Einbindung per `import "@saas-instant/ui/fonts";`).
 */
export { Badge } from './components/Badge';
export { AuthCard } from './components/AuthCard';
export { Select } from './components/Select';
export { DateField } from './components/DateField';
export { Dialog } from './components/Dialog';
export { InputField } from './components/InputField';
export { EntryBadge } from './components/EntryBadge';
export { FilterChips, type FilterChip } from './components/FilterChips';
export { DangerCard } from './components/DangerCard';
export { IconButton } from './components/IconButton';
export { Card } from './components/Card';
export { MetricTile, type TileKind } from './components/MetricTile';
export { Button } from './components/Button';
export { NoticeBar, type NoticeKind } from './components/NoticeBar';
export { Spinner, Skeleton } from './components/LoadingIndicator';
export { EmptyState } from './components/EmptyState';
export { Tabs, type TabsEntry } from './components/Tabs';
export { Switch } from './components/Switch';
export { Slider } from './components/Slider';
export { StatusPill, type StatusKind } from './components/StatusPill';
export { Table } from './components/Table';
export { ToastProvider, useToast } from './components/Toast';
export { Tooltip } from './components/Tooltip';
export { Menu, type MenuItem } from './components/Menu';
export { RowLink, ROW_LINK_CLASSES } from './components/RowLink';

export { ENTRY, type EntryType, type EntryStyle } from './entry-colors';

export { uiTexts, uiT, configureUiTexts, type UiTextKey, type UiTranslator } from './i18n';
