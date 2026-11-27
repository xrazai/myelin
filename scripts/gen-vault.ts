// Synthetic vaults for tests and benchmarks.
//   npm run gen-vault -- --notes 10000 [--seed 1] [--out <empty folder outside the repo>]
// Same `notes` + `seed` gives the same paths and bytes. Prints a JSON summary to stdout.
// Links are `[[basename]]`; basenames are unique across the vault. A few point to no note.
// Run directly by Node (type stripping): erasable TypeScript only, `node:*` imports only.

import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const AREAS = ['Projetos', 'Estudos', 'Referências', 'Diário', 'Anotações', 'Reuniões', 'Ideias', 'Pesquisa'];

const TOPICS = [
  'neurociência', 'fotossíntese', 'irrigação', 'tipografia', 'cerâmica', 'astronomia',
  'fermentação', 'urbanismo', 'estatística', 'marcenaria', 'linguística', 'botânica',
  'programação', 'filosofia', 'economia', 'culinária', 'fotografia', 'música', 'história',
  'meditação', 'tecelagem', 'automação', 'micologia', 'cartografia', 'ótica', 'pedagogia',
];

const KINDS = [
  'Reflexão sobre', 'Resumo de', 'Anotação de', 'Ideia para', 'Revisão de', 'Dúvida sobre',
  'Experimento com', 'Leitura sobre', 'Plano de', 'Conexões de', 'Introdução à', 'Questões de',
];

const SUBJECTS = [
  'A bainha de mielina', 'O caderno', 'Essa hipótese', 'A próxima etapa', 'O experimento',
  'A anotação antiga', 'O método', 'Cada sinapse', 'A referência principal', 'O orçamento',
  'A reunião de terça', 'O protótipo', 'Uma observação rápida', 'A memória de longo prazo',
];

const VERBS = [
  'reforça', 'contradiz', 'explica', 'amplia', 'resume', 'complementa', 'questiona',
  'organiza', 'antecipa', 'simplifica', 'documenta', 'ilumina',
];

const OBJECTS = [
  'a conexão entre as ideias', 'o raciocínio da semana passada', 'a decisão sobre o índice',
  'o padrão que já tinha aparecido', 'a diferença entre intuição e evidência',
  'o ritmo de revisão', 'a solução mais básica', 'a coleção de exemplos',
  'o vocabulário específico', 'a relação com o capítulo três', 'o próximo passo prático',
  'a manutenção do jardim', 'uma exceção difícil de prever',
];

const TAILS = [
  '', '', '', ' com bastante precisão', ' de um jeito inesperado', ', mas ainda falta validação',
  ', segundo as últimas medições', ' (ver também as observações)', ' à medida que o texto cresce',
  ', e isso não é coincidência',
];

type Rng = () => number;

/** mulberry32: small, seeded, integer-only, so output does not depend on the platform. */
function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

/** Index in [0, size), heavily favoring low indices: this is what makes hubs. */
function skewed(rng: Rng, size: number): number {
  const r = rng();
  return Math.floor(r * r * r * size);
}

interface Cluster {
  topic: string;
  /** Note ids; the first one is the cluster's hub. */
  notes: number[];
}

interface Note {
  name: string;
  folder: string;
  role: 'home' | 'global-hub' | 'hub' | 'note';
  cluster: number;
}

interface Plan {
  notes: Note[];
  clusters: Cluster[];
  globalHubs: number[];
}

/** First pass: every name and folder, because links need their targets up front. */
function plan(total: number, seed: number): Plan {
  const rng = mulberry32(seed);
  const notes: Note[] = [{ name: 'Home', folder: '', role: 'home', cluster: -1 }];
  const clusters: Cluster[] = [];
  const globalHubs: number[] = [];

  const hubCount = Math.min(TOPICS.length, Math.max(3, Math.floor(total / 500)));
  for (let i = 0; i < hubCount; i++) {
    globalHubs.push(notes.length);
    notes.push({ name: `Mapa de ${TOPICS[i]}`, folder: '', role: 'global-hub', cluster: -1 });
  }

  while (notes.length < total) {
    const c = clusters.length;
    const id = String(c + 1).padStart(4, '0');
    const topic = pick(rng, TOPICS);
    // Many small clusters, a few large ones.
    const wanted = 8 + skewed(rng, 280);
    const size = Math.min(wanted, total - notes.length);
    const folder = `${pick(rng, AREAS)}/${capitalize(topic)} ${id}`;
    const cluster: Cluster = { topic, notes: [notes.length] };
    notes.push({ name: `Índice de ${topic} ${id}`, folder, role: 'hub', cluster: c });
    for (let i = 1; i < size; i++) {
      const number = String(notes.length).padStart(6, '0');
      const sub = size > 60 && rng() < 0.35 ? `/${pick(rng, ['Arquivo', 'Rascunhos', 'Seleção'])}` : '';
      cluster.notes.push(notes.length);
      notes.push({
        name: `${pick(rng, KINDS)} ${topic} ${number}`,
        folder: folder + sub,
        role: 'note',
        cluster: c,
      });
    }
    clusters.push(cluster);
  }
  return { notes, clusters, globalHubs };
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function sentence(rng: Rng): string {
  return `${pick(rng, SUBJECTS)} ${pick(rng, VERBS)} ${pick(rng, OBJECTS)}${pick(rng, TAILS)}.`;
}

function paragraph(rng: Rng): string {
  return Array.from({ length: int(rng, 2, 5) }, () => sentence(rng)).join(' ');
}

/** Link targets of an ordinary note: mostly its own cluster, some far away. */
function noteTargets(rng: Rng, self: number, { notes, clusters, globalHubs }: Plan): string[] {
  const own = clusters[notes[self]!.cluster]!;
  if (rng() < 0.08) return [];
  const targets = new Set<string>();
  const count = 1 + skewed(rng, 12);
  for (let i = 0; i < count; i++) {
    const roll = rng();
    let target: number;
    if (roll < 0.1) target = own.notes[0]!;
    else if (roll < 0.8) target = own.notes[skewed(rng, own.notes.length)]!;
    else if (roll < 0.92) {
      const other = clusters[skewed(rng, clusters.length)]!;
      target = other.notes[skewed(rng, other.notes.length)]!;
    } else if (roll < 0.99) target = globalHubs[skewed(rng, globalHubs.length)]!;
    else {
      targets.add(`Nota ainda não escrita ${int(rng, 1, 500)}`);
      continue;
    }
    if (target !== self) targets.add(notes[target]!.name);
  }
  return [...targets];
}

/** Second pass: the text of one note depends only on the plan, the seed and its id. */
function render(id: number, seed: number, vault: Plan): { text: string; links: number } {
  const { notes, clusters, globalHubs } = vault;
  const note = notes[id]!;
  const rng = mulberry32(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(id + 1, 0xc2b2ae35));
  const blocks = [`# ${note.name}`, paragraph(rng)];
  let links = 0;
  const link = (target: string) => {
    links++;
    return `[[${target}]]`;
  };
  const list = (title: string, ids: number[]) => {
    if (ids.length > 0) {
      blocks.push(`## ${title}`, ids.map((i) => `- ${link(notes[i]!.name)}`).join('\n'));
    }
  };

  if (note.role === 'home') {
    list('Mapas', globalHubs);
  } else if (note.role === 'global-hub') {
    // Every cluster hub is listed by exactly one map, so the vault is connected.
    const slot = globalHubs.indexOf(id);
    list('Índices', clusters.filter((_, c) => c % globalHubs.length === slot).map((c) => c.notes[0]!));
  } else if (note.role === 'hub') {
    list('Notas', clusters[note.cluster]!.notes.slice(1).filter(() => rng() < 0.8));
  } else {
    // 1% long notes, to exercise the editor and the indexer.
    const sections = rng() < 0.01 ? int(rng, 20, 60) : int(rng, 0, 3);
    for (let s = 0; s < sections; s++) {
      if (rng() < 0.4) blocks.push(`## ${capitalize(pick(rng, OBJECTS).replace(/^(a|o|uma) /, ''))}`);
      blocks.push(paragraph(rng));
    }
    if (rng() < 0.15) {
      blocks.push(`- **Atenção:** ${sentence(rng)}\n- ${sentence(rng)}\n- [ ] ${sentence(rng)}`);
    }
    if (rng() < 0.05) blocks.push('```ts\nconst sinapse = { origem: "ação", peso: 1 };\n```');
    const targets = noteTargets(rng, id, vault);
    const inline = targets.splice(0, int(rng, 0, targets.length));
    if (inline.length > 0) {
      blocks.push(inline.map((t) => `${pick(rng, SUBJECTS)} ${pick(rng, VERBS)} ${link(t)}.`).join(' '));
    }
    if (targets.length > 0) {
      blocks.push('## Relacionadas', targets.map((t) => `- ${link(t)}`).join('\n'));
    }
  }
  return { text: `${blocks.join('\n\n')}\n`.normalize('NFC'), links };
}

export interface GenerateOptions {
  /** Total number of notes. */
  notes: number;
  seed: number;
  /** Must not exist or be empty, and must be outside this repo. */
  out: string;
}

export interface VaultSummary {
  out: string;
  seed: number;
  notes: number;
  folders: number;
  links: number;
  bytes: number;
  /** SHA-256 over every relative path and file content, in path order. */
  hash: string;
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function generateVault(options: GenerateOptions): Promise<VaultSummary> {
  const { notes: total, seed } = options;
  if (!Number.isInteger(total) || total < 20) throw new Error('notes must be an integer >= 20');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('seed must be an integer between 0 and 4294967295');
  }
  const out = resolve(options.out);
  if (isInside(REPO_ROOT, out)) throw new Error(`output must be outside the repo: ${out}`);
  const existing = await readdir(out).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length > 0) throw new Error(`output folder is not empty: ${out}`);

  const vault = plan(total, seed);
  const paths = vault.notes.map((n) => (n.folder ? `${n.folder}/` : '') + `${n.name}.md`).map((p) => p.normalize('NFC'));

  const folders = new Set(paths.map((p) => dirname(p)).filter((f) => f !== '.'));
  await mkdir(out, { recursive: true });
  for (const folder of folders) await mkdir(join(out, folder), { recursive: true });
  // Area folders hold no notes themselves but are folders of the vault too.
  for (const folder of [...folders]) {
    for (let parent = dirname(folder); parent !== '.'; parent = dirname(parent)) folders.add(parent);
  }

  const digests = new Array<string>(total);
  let links = 0;
  let bytes = 0;
  let next = 0;
  const writer = async () => {
    while (next < total) {
      const id = next++;
      const rendered = render(id, seed, vault);
      links += rendered.links;
      bytes += Buffer.byteLength(rendered.text, 'utf8');
      digests[id] = createHash('sha256').update(rendered.text, 'utf8').digest('hex');
      await writeFile(join(out, paths[id]!), rendered.text, { encoding: 'utf8', flag: 'wx' });
    }
  };
  await Promise.all(Array.from({ length: 64 }, writer));

  const hash = createHash('sha256');
  // Plain code-unit order: locale-independent.
  const order = paths.map((_, i) => i).sort((a, b) => (paths[a]! < paths[b]! ? -1 : 1));
  for (const i of order) hash.update(`${paths[i]}\0${digests[i]}\n`, 'utf8');

  return { out, seed, notes: total, folders: folders.size, links, bytes, hash: hash.digest('hex') };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      notes: { type: 'string', default: '10000' },
      seed: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  const notes = Number(values.notes);
  const seed = Number(values.seed);
  const out = values.out ?? join(tmpdir(), 'myelin-vaults', `${notes}-seed${seed}`);
  const start = performance.now();
  const summary = await generateVault({ notes, seed, out });
  console.log(JSON.stringify({ ...summary, ms: Math.round(performance.now() - start) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
