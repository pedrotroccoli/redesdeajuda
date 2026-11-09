// Triagem: o que a pessoa precisa (linguagem dela) -> tipos de serviço.
// Ícone ajuda quem lê pouco. Uma necessidade pode apontar p/ várias categorias.

import type { CategoriaId } from './categorias';

export interface Necessidade {
  id: string;
  icone: string;
  label: string;
  categorias: CategoriaId[];
}

export const NECESSIDADES: Necessidade[] = [
  { id: 'fome', icone: '🍽️', label: 'Tenho fome / preciso de alimentos', categorias: ['osc', 'cras'] },
  { id: 'roupas', icone: '🧥', label: 'Preciso de roupas ou agasalho', categorias: ['osc'] },
  { id: 'cadunico', icone: '📋', label: 'Bolsa Família / CadÚnico', categorias: ['cras'] },
  { id: 'beneficio', icone: '🤝', label: 'Preciso de ajuda / benefício social', categorias: ['cras'] },
  { id: 'saude', icone: '🏥', label: 'Atendimento de saúde ou vacina', categorias: ['ubs'] },
  { id: 'saude_mental', icone: '🧠', label: 'Saúde mental, álcool ou drogas', categorias: ['caps'] },
  { id: 'violencia', icone: '🆘', label: 'Sofri violência ou ameaça', categorias: ['creas', 'conselho_tutelar'] },
  { id: 'crianca', icone: '🧒', label: 'Criança ou adolescente em risco', categorias: ['conselho_tutelar', 'creas'] },
  { id: 'rua', icone: '🏠', label: 'Estou em situação de rua', categorias: ['creas', 'osc'] },
  { id: 'escola', icone: '🎒', label: 'Matricular na escola', categorias: ['escola'] },
  { id: 'curso', icone: '📚', label: 'Quero um curso ou trabalho', categorias: ['curso'] },
];
