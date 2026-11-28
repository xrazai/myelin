// Demo of @myelin/graph: `npm run demo -w @myelin/graph`. `?nodes=100000` picks the size.
// The colors here are Myelin's: they come in through the options, as any host's would.

import { MyelinGraph } from '../src/index.ts';
import { syntheticGraph } from './synthetic.ts';

const canvas = document.querySelector('canvas')!;
const select = document.querySelector<HTMLSelectElement>('#nodes')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;

const graph = new MyelinGraph(canvas, {
  colors: {
    background: '#0b0f0e',
    node: '#8a9992',
    activeNode: '#52b788',
    edge: '#8a9992',
    strongEdge: '#52b788',
    pulse: '#f1ead8',
    constellations: ['#52b788', '#b59f6b', '#6f9fb5', '#a38bb0', '#8fae5d', '#b5806b'],
  },
});

let summary = '';

function load(nodeCount: number): void {
  const data = syntheticGraph(nodeCount, 1);
  summary = `${nodeCount.toLocaleString('en')} nodes, ${(data.edges.length / 2).toLocaleString('en')} edges`;
  status.value = `${summary}, laying out`;
  graph.setGraph(data);
}

graph.on('layoutChange', (_positions, { iteration, done }) => {
  status.value = `${summary}, ${done ? 'settled at' : 'layout'} iteration ${iteration}`;
});
graph.on('layoutError', (error) => {
  status.value = error.message;
});

select.addEventListener('change', () => load(Number(select.value)));
document.querySelector('#fit')!.addEventListener('click', () => graph.fit());

const asked = new URLSearchParams(location.search).get('nodes');
if (asked && [...select.options].some((option) => option.value === asked)) select.value = asked;
load(Number(select.value));

// For the console.
Object.assign(window, { graph });
