// Catálogo de tipos de serviço da rede de apoio.
// Usado pelo mapa (cor/legenda/filtro) e, na próxima fase, pela triagem
// (necessidade -> categorias).

export type CategoriaId =
  | 'cras'
  | 'creas'
  | 'ubs'
  | 'caps'
  | 'conselho_tutelar'
  | 'escola'
  | 'curso'
  | 'osc'
  | 'parceiro';

export interface Categoria {
  id: CategoriaId;
  label: string; // nome curto p/ legenda
  nome: string; // nome por extenso
  cor: string; // cor do pin/legenda
  fonte: string; // base de dados oficial
}

export const CATEGORIAS: Categoria[] = [
  { id: 'cras', label: 'CRAS', nome: 'Centro de Referência de Assistência Social', cor: '#2563eb', fonte: 'CadSUAS' },
  { id: 'creas', label: 'CREAS', nome: 'Centro de Referência Especializado de Assistência Social', cor: '#4f46e5', fonte: 'CadSUAS' },
  { id: 'ubs', label: 'UBS', nome: 'Unidade Básica de Saúde', cor: '#16a34a', fonte: 'CNES' },
  { id: 'caps', label: 'CAPS', nome: 'Centro de Atenção Psicossocial', cor: '#0d9488', fonte: 'CNES' },
  { id: 'conselho_tutelar', label: 'Conselho Tutelar', nome: 'Conselho Tutelar', cor: '#dc2626', fonte: 'Prefeitura' },
  { id: 'escola', label: 'Escola', nome: 'Escola pública', cor: '#f59e0b', fonte: 'INEP' },
  { id: 'curso', label: 'Curso', nome: 'Curso gratuito / capacitação', cor: '#ea580c', fonte: 'Verificado' },
  { id: 'osc', label: 'OSC', nome: 'Organização da Sociedade Civil', cor: '#9333ea', fonte: 'Mapa das OSC (IPEA)' },
  { id: 'parceiro', label: 'Parceiro', nome: 'Parceiro da rede de apoio', cor: '#e11d48', fonte: 'Rede' },
];

export const CATEGORIA_POR_ID: Record<CategoriaId, Categoria> = Object.fromEntries(
  CATEGORIAS.map((c) => [c.id, c])
) as Record<CategoriaId, Categoria>;
