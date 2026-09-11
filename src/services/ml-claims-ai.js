const { env } = require('../config/env');
const { supabase } = require('../db/supabase');
const { getMercadoLivreAccount, mercadoLivreFetch } = require('./mercadolivre');

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_MODEL = env.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6';

async function readJson(response){
  const text = await response.text();
  if(!text) return {};
  try{return JSON.parse(text);}catch{return {};}
}

async function loadProduct(detail){
  const itemId = String(detail?.product_item_id || '').trim();
  if(!itemId) return null;
  const account = await getMercadoLivreAccount();
  if(!account) return null;
  try{
    const [itemReq, descReq] = await Promise.all([
      mercadoLivreFetch(`/items/${encodeURIComponent(itemId)}`, account),
      mercadoLivreFetch(`/items/${encodeURIComponent(itemId)}/description`, account)
    ]);
    const item = await readJson(itemReq.response);
    const desc = await readJson(descReq.response);
    if(!itemReq.response.ok) return null;
    return {
      item_id:itemId,
      title:item?.title || detail?.product_title || '',
      sku:item?.seller_custom_field || item?.seller_sku || detail?.seller_sku || '',
      warranty:item?.warranty || '',
      attributes:(item?.attributes || []).slice(0,40).map(a=>`${a?.name||a?.id}: ${a?.value_name||a?.value_id||''}`).join(' | '),
      description:String(desc?.plain_text || desc?.text || '').slice(0,7000)
    };
  }catch{return null;}
}

async function loadKnowledge(){
  try{
    const { data, error } = await supabase.from('matrix_ai_knowledge')
      .select('category,title,content,priority')
      .eq('active',true).eq('approved',true)
      .order('priority',{ascending:false}).limit(80);
    if(error) return [];
    return data || [];
  }catch{return [];}
}

function historyText(messages){
  return (messages || []).slice(-40).map((m,i)=>{
    const role = m?.direction === 'outbound' ? 'SHOP MATRIX' : (m?.sender_role === 'mediator' ? 'MERCADO LIVRE' : 'CLIENTE/MERCADO LIVRE');
    const mark = i === (messages || []).slice(-40).length - 1 ? ' [MAIS RECENTE]' : '';
    return `${role}${mark}: ${String(m?.text || '').slice(0,1400)}`;
  }).join('\n');
}

async function suggestClaimResponse(detail, mode='normal'){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada.');
  if(!detail?.claim_id) throw new Error('Reclamação inválida.');

  const [product, knowledge] = await Promise.all([loadProduct(detail), loadKnowledge()]);
  const official = knowledge.length
    ? knowledge.map(k=>`- [${k.category}] ${k.title}: ${k.content}`).join('\n')
    : '- Sem regras adicionais cadastradas.';

  const instructionMode = mode === 'short'
    ? 'Seja especialmente curta: no máximo 220 caracteres.'
    : 'Seja objetiva e resolutiva, com no máximo 500 caracteres.';

  const instructions = `Você é a assistente da Shop Matrix respondendo uma reclamação/mediação do Mercado Livre. Responda em português do Brasil. Leia TODO o histórico antes de sugerir. Não repita testes já feitos. Não invente diagnóstico, promessa, prazo, reembolso, política ou característica do produto. Em mediação, seja profissional e factual. Não ataque o cliente nem o Mercado Livre. Se faltar informação, faça uma pergunta objetiva. ${instructionMode} Retorne apenas o texto que o operador poderá revisar e enviar.`;

  const input = `RECLAMAÇÃO: ${detail.claim_id}\nPEDIDO: ${detail.order_id || 'não informado'}\nSTATUS: ${detail.category || detail.status || ''}\nASSUNTO: ${detail.subject || ''}\nPROBLEMA: ${detail.problem || detail.description || ''}\nAÇÕES DISPONÍVEIS: ${(detail.available_actions || []).join(', ')}\n\nPRODUTO:\n${product ? `Título: ${product.title}\nAnúncio: ${product.item_id}\nSKU: ${product.sku}\nGarantia: ${product.warranty}\nAtributos: ${product.attributes}\nDescrição: ${product.description}` : `Título: ${detail.product_title || ''}\nSKU: ${detail.seller_sku || ''}`}\n\nCONHECIMENTO OFICIAL:\n${official}\n\nHISTÓRICO CRONOLÓGICO:\n${historyText(detail.messages)}\n\nGere a melhor resposta para o ponto atual da reclamação.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:OPENAI_MODEL,instructions,input})
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data?.error?.message || 'OpenAI recusou a sugestão.');
  let text = String(data?.output_text || '').trim();
  if(!text){
    const parts=[];
    for(const item of data?.output || []) for(const c of item?.content || []) if(c?.type==='output_text'&&c?.text) parts.push(c.text);
    text = parts.join('\n').trim();
  }
  if(!text) throw new Error('A IA não retornou sugestão.');
  return { suggestion:text.slice(0,500) };
}

module.exports = { suggestClaimResponse };
