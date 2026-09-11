(()=>{
const $=s=>document.querySelector(s);
let lastSuggestion='';
function installStyle(){
 if(document.getElementById('claimsAiStyle'))return;
 const s=document.createElement('style');s.id='claimsAiStyle';s.textContent=`
 .claims-ai-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
 .claims-ai-btn{min-height:48px;border:1px solid #7b68f5;background:linear-gradient(180deg,#6653ec,#4939bd);color:#fff;border-radius:10px;padding:0 14px;font-weight:850;white-space:nowrap}
 .claims-ai-mini{min-height:38px;border:1px solid #34557d;background:#10213a;color:#dbe9ff;border-radius:9px;padding:0 10px;font-weight:750}
 .claims-ai-btn:disabled,.claims-ai-mini:disabled{opacity:.45;cursor:not-allowed}
 @media(max-width:820px){.claims-ai-actions{width:100%}.claims-ai-btn{flex:1}}
 `;document.head.appendChild(s);
}
async function api(url,opts={}){const r=await fetch(url,{cache:'no-store',...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok||d.sucesso===false)throw new Error(d.mensagem||`HTTP ${r.status}`);return d;}
function selectedClaim(){return String($('.claim-row.selected')?.dataset?.claimId||'').trim();}
async function generate(mode='normal'){
 const reply=$('.composer textarea');const main=$('#claimsAiSuggest');if(!reply||!main)return;
 const claimId=selectedClaim();if(!claimId)return;
 const buttons=[...document.querySelectorAll('.claims-ai-actions button')];buttons.forEach(b=>b.disabled=true);const old=main.textContent;main.textContent='ANALISANDO...';
 try{
  const detail=await api(`/api/reclamacoes/ml/${encodeURIComponent(claimId)}`);
  const result=await api('/api/claims-ai-suggest',{method:'POST',body:JSON.stringify({detail:detail.reclamacao,mode})});
  lastSuggestion=String(result.suggestion||'');reply.value=lastSuggestion;reply.focus();reply.dispatchEvent(new Event('input',{bubbles:true}));
 }catch(e){alert(`Não consegui gerar a sugestão: ${e.message}`);}
 finally{main.textContent=old;buttons.forEach(b=>b.disabled=false);}
}
function install(){
 installStyle();const composer=$('.composer');if(!composer||$('#claimsAiSuggest'))return;
 const send=composer.querySelector('.send');if(!send)return;
 const box=document.createElement('div');box.className='claims-ai-actions';box.innerHTML='<button type="button" class="claims-ai-btn" id="claimsAiSuggest">✨ SUGESTÃO DA IA</button><button type="button" class="claims-ai-mini" id="claimsAiAgain">Gerar novamente</button><button type="button" class="claims-ai-mini" id="claimsAiShort">Mais curta</button>';
 composer.insertBefore(box,send);$('#claimsAiSuggest').onclick=()=>generate('normal');$('#claimsAiAgain').onclick=()=>generate('normal');$('#claimsAiShort').onclick=()=>generate('short');
}
const target=document.getElementById('detailPanel');if(target)new MutationObserver(()=>setTimeout(install,0)).observe(target,{childList:true,subtree:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
