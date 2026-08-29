import { describe, expect, mock, test } from 'bun:test';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CustomWidgetsService } from '../../custom-widgets/custom-widgets.service';
import type { PluginsService } from '../../plugins/plugins.service';
import { WidgetTemplatesService } from './widget-templates.service';

type Seed = {
  name: string; label: string; description: string; category: string;
  defaultConfig: Record<string, unknown>; minWidth: number; minHeight: number;
};
type Row = Seed & { id: number };

function harness() {
  const rows = new Map<string, Row>();
  let nextId = 1;
  const widgetTemplate = {
    findUnique: mock(async ({ where }: { where: { name: string } }) => structuredClone(rows.get(where.name) ?? null)),
    create: mock(async ({ data }: { data: Seed }) => {
      if (rows.has(data.name)) throw new Error('Duplicate seed');
      const row = { ...structuredClone(data), id: nextId++ };
      rows.set(row.name, row);
      return structuredClone(row);
    }),
    update: mock(async ({ where, data }: { where: { name: string }; data: Partial<Seed> }) => {
      const previous = rows.get(where.name);
      if (!previous) throw new Error('Missing seed');
      const row = { ...previous, ...structuredClone(data) };
      rows.set(where.name, row);
      return structuredClone(row);
    }),
  };
  const service = new WidgetTemplatesService({ widgetTemplate } as unknown as PrismaService,
    {} as CustomWidgetsService, {} as PluginsService);
  return { rows, widgetTemplate, service, clearWrites() {
    widgetTemplate.create.mockClear(); widgetTemplate.update.mockClear();
  } };
}

describe('widget template startup seed writes', () => {
  test('creates missing defaults and repeats an identical startup without writes', async () => {
    const h = harness();
    const first = await h.service.seedTemplates();
    expect(first.created).toBeGreaterThan(0);
    expect(first.skipped).toBe(0);
    expect(h.rows.has('daysuntil')).toBe(true);
    expect(h.widgetTemplate.create).toHaveBeenCalledTimes(first.created);
    const before = structuredClone([...h.rows]);
    h.clearWrites();
    expect(await h.service.seedTemplates()).toEqual({ created: 0, skipped: first.created });
    expect(h.widgetTemplate.create).not.toHaveBeenCalled();
    expect(h.widgetTemplate.update).not.toHaveBeenCalled();
    expect([...h.rows]).toEqual(before);
  });

  test('ignores JSON key order and fields outside the managed DaysUntil defaults', async () => {
    const h = harness();
    await h.service.seedTemplates();
    const days = h.rows.get('daysuntil')!;
    days.defaultConfig = Object.fromEntries(Object.entries(days.defaultConfig).reverse());
    days.category = 'custom-category';
    h.rows.get('clock')!.label = 'Customized clock';
    const before = structuredClone([...h.rows]);
    h.clearWrites();
    await h.service.seedTemplates();
    expect(h.widgetTemplate.create).not.toHaveBeenCalled();
    expect(h.widgetTemplate.update).not.toHaveBeenCalled();
    expect([...h.rows]).toEqual(before);
  });

  test('updates each changed managed field once without rewriting unrelated template fields', async () => {
    for (const field of ['label', 'description', 'defaultConfig', 'minWidth', 'minHeight'] as const) {
      const h = harness();
      await h.service.seedTemplates();
      const days = h.rows.get('daysuntil')!;
      const expected = { label: days.label, description: days.description, defaultConfig: structuredClone(days.defaultConfig),
        minWidth: days.minWidth, minHeight: days.minHeight };
      if (field === 'defaultConfig') days.defaultConfig = { ...days.defaultConfig, obsolete: { nested: true } };
      else if (field === 'minWidth' || field === 'minHeight') days[field]++;
      else days[field] += ' outdated';
      days.category = 'preserve-category';
      const before = structuredClone([...h.rows].filter(([name]) => name !== 'daysuntil'));
      h.clearWrites();
      await h.service.seedTemplates();
      expect(h.widgetTemplate.update).toHaveBeenCalledTimes(1);
      expect(h.widgetTemplate.update).toHaveBeenCalledWith({ where: { name: 'daysuntil' }, data: expected });
      expect(h.widgetTemplate.create).not.toHaveBeenCalled();
      expect(h.rows.get('daysuntil')).toEqual({ ...days, ...expected });
      expect([...h.rows].filter(([name]) => name !== 'daysuntil')).toEqual(before);
      h.clearWrites();
      await h.service.seedTemplates();
      expect(h.widgetTemplate.update).not.toHaveBeenCalled();
    }
  });

  test('repairs one missing template without rewriting the already installed defaults', async () => {
    const h = harness();
    const first = await h.service.seedTemplates();
    const missing = structuredClone(h.rows.get('clock')!);
    h.rows.delete('clock');
    h.clearWrites();
    expect(await h.service.seedTemplates()).toEqual({ created: 1, skipped: first.created - 1 });
    expect(h.widgetTemplate.create).toHaveBeenCalledTimes(1);
    expect(h.widgetTemplate.create).toHaveBeenCalledWith({ data: {
      name: missing.name, label: missing.label, description: missing.description, category: missing.category,
      defaultConfig: missing.defaultConfig, minWidth: missing.minWidth, minHeight: missing.minHeight,
    } });
    expect(h.widgetTemplate.update).not.toHaveBeenCalled();
  });
});
