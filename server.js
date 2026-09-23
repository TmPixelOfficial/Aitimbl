import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { Rcon } from 'rcon-client';

const app=express();
const dir=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(dir,'data'), UP=path.join(DATA,'uploads'); fs.mkdirSync(UP,{recursive:true});
const FILES={memory:path.join(DATA,'memory.json'),chats:path.join(DATA,'chats.json'),settings:path.join(DATA,'settings.json'),files:path.join(DATA,'files.json'),projects:path.join(DATA,'projects.json')};
const load=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2),'utf8');
for(const [p,f] of [[FILES.memory,[]],[FILES.chats,[]],[FILES.settings,{}],[FILES.files,[]],[FILES.projects,[]]]) if(!fs.existsSync(p)) save(p,f);

app.use(express.json({limit:'25mb'}));
app.use(express.urlencoded({extended:true,limit:'25mb'}));

const APP_PASSWORD=process.env.APP_PASSWORD||'';
const sessions=new Map();

function auth(req,res,next){
  if(!APP_PASSWORD)return next();
  const t=(req.headers.authorization||'').replace(/^Bearer /,'')||req.headers['x-app-password']||req.cookies?.session;
  if(t===APP_PASSWORD||sessions.has(t))return next();
  return res.status(401).json({error:'Требуется вход.'});
}

app.use((req,res,next)=>{
  if(!APP_PASSWORD||req.path==='/api/login'||req.path==='/api/health')return next();
  if(req.path.startsWith('/api/'))return auth(req,res,next);
  next();
});

app.use(express.static(path.join(dir,'public')));

const upload=multer({
  dest:UP,
  limits:{fileSize:25*1024*1024}
});

const SYSTEM=`Ты — TIMBLOGPLAY AI, универсальный персональный ИИ-агент. Отвечай на языке пользователя. У тебя есть инструменты: память, веб-поиск, калькулятор, Minecraft-команды и сведения о загруженных файлах. Используй инструменты, когда это реально нужно. Никогда не выдумывай результаты инструментов, содержимое файлов или источники. Если использован веб-поиск — укажи источники с URL. Если данных не хватает — скажи об этом. Будь конкретным и полезным. Для Minecraft учитывай Java Edition и версию, если она указана.`;

function tokenize(s){
  return String(s).toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)||[];
}

function memSearch(q){
  const m=load(FILES.memory,[]),w=tokenize(q);
  return m.map(x=>({
    ...x,
    score:w.reduce((n,k)=>n+(String(x.text).toLowerCase().includes(k)?1:0),0)
  })).filter(x=>x.score).sort((a,b)=>b.score-a.score).slice(0,12);
}

function remember(text,source='user'){
  const m=load(FILES.memory,[]);
  m.push({
    id:randomUUID(),
    text:String(text).trim(),
    source,
    createdAt:Date.now()
  });
  save(FILES.memory,m.slice(-1000));
  return {saved:true,text:String(text).trim()};
}

async function webSearch(query){
  const url=`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 TIMBLOGPLAY-AI'}});
  if(!r.ok)throw Error(`Веб-поиск HTTP ${r.status}`);

  const html=await r.text();
  const out=[];
  const re=/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let m;
  while((m=re.exec(html))&&out.length<10){
    let u=m[1];
    try{u=decodeURIComponent(u)}catch{}

    out.push({
      title:m[2]
        .replace(/<[^>]+>/g,'')
        .replace(/&amp;/g,'&')
        .replace(/&#x27;/g,"'")
        .trim(),
      url:u
    });
  }

  return {query,results:out};
}

function calc(expression){
  if(!/^[0-9+\-*/().%\s]+$/.test(expression))
    throw Error('Только числа и арифметические операторы.');

  const result=Function(`"use strict";return (${expression})`)();

  if(!Number.isFinite(result))
    throw Error('Некорректный результат');

  return {expression,result};
}

function mc(command){
  const c=String(command).trim();

  if(!c.startsWith('/'))
    throw Error('Команда должна начинаться с /.');

  if(c.length>500)
    throw Error('Команда слишком длинная.');

  return {
    command:c,
    ready:true,
    executed:false
  };
}

async function extractFile(file){
  const ext=path.extname(file.originalname).toLowerCase();

  if([
    '.txt','.md','.json','.csv','.log','.js','.ts',
    '.py','.java','.mcfunction','.yml','.yaml',
    '.xml','.html','.css'
  ].includes(ext)){
    return fs.readFileSync(file.path,'utf8').slice(0,120000);
  }

  if(ext==='.pdf')
    return (await pdfParse(fs.readFileSync(file.path))).text.slice(0,120000);

  if(ext==='.docx')
    return (await mammoth.extractRawText({path:file.path})).value.slice(0,120000);

  return '';
}

const tools=[
  {
    type:'function',
    function:{
      name:'web_search',
      description:'Ищи актуальную информацию в интернете и верни результаты с URL.',
      parameters:{
        type:'object',
        properties:{
          query:{type:'string'}
        },
        required:['query']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'memory_search',
      description:'Найди релевантные записи в долговременной памяти пользователя.',
      parameters:{
        type:'object',
        properties:{
          query:{type:'string'}
        },
        required:['query']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'memory_write',
      description:'Сохрани важную информацию пользователя в долговременную память.',
      parameters:{
        type:'object',
        properties:{
          text:{type:'string'}
        },
        required:['text']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'calculator',
      description:'Посчитай арифметическое выражение.',
      parameters:{
        type:'object',
        properties:{
          expression:{type:'string'}
        },
        required:['expression']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'minecraft_command',
      description:'Проверь и подготовь Minecraft Java команду. Не выполняй её сам.',
      parameters:{
        type:'object',
        properties:{
          command:{type:'string'}
        },
        required:['command']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'files_context',
      description:'Найди содержимое загруженных пользователем файлов по запросу.',
      parameters:{
        type:'object',
        properties:{
          query:{type:'string'}
        },
        required:['query']
      }
    }
  }
];

async function runTool(name,args){
  switch(name){

    case 'web_search':
      return await webSearch(args.query);

    case 'memory_search':
      return memSearch(args.query);

    case 'memory_write':
      return remember(args.text,'ai');

    case 'calculator':
      return calc(args.expression);

    case 'minecraft_command':
      return mc(args.command);

    case 'files_context':{
      const fsx=load(FILES.files,[]);
      const w=tokenize(args.query);

      return fsx
        .map(f=>({
          name:f.name,
          text:f.extracted||'',
          score:w.reduce(
            (n,k)=>n+(String(f.extracted||'').toLowerCase().includes(k)?1:0),
            0
          )
        }))
        .filter(x=>x.score&&x.text)
        .sort((a,b)=>b.score-a.score)
        .slice(0,5)
        .map(x=>({
          name:x.name,
          text:x.text.slice(0,30000)
        }));
    }

    default:
      throw Error('Неизвестный инструмент');
  }
}


/* =========================================================
   AI PROVIDERS
   Gemini → Groq → Hugging Face
   ========================================================= */

function providerList(){

  const list=[];

  const add=(name,base,token,model)=>{
    if(token)
      list.push({
        name,
        base,
        token,
        model
      });
  };

  const provider=(process.env.PROVIDER||'auto').toLowerCase();


  /* AUTO MODE */

  if(provider==='auto'){

    add(
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      process.env.GEMINI_API_KEY,
      'gemini-3.8-flash'
    );

    add(
      'groq',
      'https://api.groq.com/openai/v1',
      process.env.GROQ_API_KEY,
      'openai/gpt-oss-20b'
    );

    add(
      'huggingface',
      'https://router.huggingface.co/v1',
      process.env.HF_TOKEN,
      process.env.MODEL||'openai/gpt-oss-120b:fastest'
    );
  }


  /* MANUAL GEMINI */

  else if(provider==='gemini'){

    add(
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      process.env.GEMINI_API_KEY,
      process.env.MODEL||'gemini-3.8-flash'
    );
  }


  /* MANUAL GROQ */

  else if(provider==='groq'){

    add(
      'groq',
      'https://api.groq.com/openai/v1',
      process.env.GROQ_API_KEY,
      process.env.MODEL||'openai/gpt-oss-20b'
    );
  }


  /* MANUAL HUGGING FACE */

  else if(provider==='huggingface'){

    add(
      'huggingface',
      'https://router.huggingface.co/v1',
      process.env.HF_TOKEN,
      process.env.MODEL||'openai/gpt-oss-120b:fastest'
    );
  }


  /* OPENAI */

  else if(provider==='openai'){

    add(
      'openai',
      'https://api.openai.com/v1',
      process.env.OPENAI_API_KEY,
      process.env.MODEL||'gpt-4o-mini'
    );
  }


  /* CUSTOM */

  else if(provider==='custom'){

    add(
      'custom',
      (process.env.OPENAI_BASE_URL||'').replace(/\/$/,''),
      process.env.OPENAI_API_KEY||process.env.API_KEY,
      process.env.MODEL||'gpt-4o-mini'
    );
  }


  /* OLLAMA */

  else if(provider==='ollama'){

    add(
      'ollama',
      (process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434/v1').replace(/\/$/,''),
      'ollama',
      process.env.MODEL||'llama3.2'
    );
  }

  return list;
}


async function modelRequest(messages,{toolChoice='auto',visionData=null}={}){

  const providers=providerList();

  if(!providers.length){

    throw Error(
      'Не настроен ключ модели. Добавь GEMINI_API_KEY, GROQ_API_KEY или HF_TOKEN в Render.'
    );
  }

  let lastError=null;


  for(const cfg of providers){

    try{

      let mm=messages.map(x=>({...x}));


      /* IMAGE */

      if(visionData){

        const last=mm[mm.length-1];

        if(
          last?.role==='user' &&
          typeof last.content==='string'
        ){

          last.content=[
            {
              type:'text',
              text:last.content
            },
            {
              type:'image_url',
              image_url:{
                url:visionData
              }
            }
          ];
        }
      }


      const body={
        model:cfg.model,
        messages:mm,
        max_tokens:4500,
        tools,
        tool_choice:toolChoice
      };


      /*
        Gemini 3.8 Flash no longer needs the old temperature
        parameter, so don't send it to Gemini.
      */

      if(cfg.name!=='gemini'){
        body.temperature=.7;
      }


      const r=await fetch(
        `${cfg.base}/chat/completions`,
        {
          method:'POST',
          headers:{
            Authorization:`Bearer ${cfg.token}`,
            'Content-Type':'application/json'
          },
          body:JSON.stringify(body)
        }
      );


      const raw=await r.text();

      let d={};

      try{
        d=JSON.parse(raw);
      }catch{}


      if(!r.ok){

        lastError=Error(
          `${cfg.name}: ${
            d.error?.message ||
            d.error ||
            raw ||
            `Модель HTTP ${r.status}`
          }`
        );

        /*
          Любая ошибка провайдера →
          пробуем следующий.
        */

        continue;
      }


      const msg=d.choices?.[0]?.message;


      if(!msg)
        throw Error(`${cfg.name}: пустой ответ`);


      return msg;

    }catch(e){

      lastError=e;

    }
  }


  throw lastError ||
    Error('Все AI-провайдеры недоступны.');
}


/* =========================================================
   AGENT
   ========================================================= */

async function agent(messages){

  let current=[
    {
      role:'system',
      content:SYSTEM
    },
    ...messages
  ];

  const used=[];


  for(let step=0;step<6;step++){

    const msg=await modelRequest(
      current,
      {
        toolChoice:'auto'
      }
    );


    if(!msg.tool_calls?.length){

      return {
        reply:msg.content||'Пустой ответ',
        used
      };
    }


    current.push(msg);


    for(const call of msg.tool_calls){

      let result;

      try{

        result=await runTool(
          call.function.name,
          JSON.parse(call.function.arguments||'{}')
        );

      }catch(e){

        result={
          error:e.message
        };
      }


      used.push(call.function.name);


      current.push({
        role:'tool',
        tool_call_id:call.id,
        name:call.function.name,
        content:JSON.stringify(result)
      });
    }
  }


  return {
    reply:'Я выполнил несколько шагов, но достиг лимита инструментов. Продолжи запрос, если нужно ещё.',
    used
  };
}


/* =========================================================
   API
   ========================================================= */

app.post('/api/login',(req,res)=>{

  if(!APP_PASSWORD)
    return res.json({
      ok:true,
      protected:false,
      token:''
    });

  if(req.body?.password===APP_PASSWORD){

    const token=randomUUID();

    sessions.set(
      token,
      Date.now()
    );

    return res.json({
      ok:true,
      protected:true,
      token
    });
  }

  res.status(401).json({
    error:'Неверный пароль'
  });
});


app.get('/api/health',(req,res)=>{

  res.json({
    ok:true,
    name:'TIMBLOGPLAY AI',
    version:'MULTI-PROVIDER',
    provider:process.env.PROVIDER||'auto',
    model:process.env.MODEL||'gemini-3.8-flash',
    protected:Boolean(APP_PASSWORD),
    memory:load(FILES.memory,[]).length,
    files:load(FILES.files,[]).length,
    tools:tools.map(x=>x.function.name)
  });
});


app.get('/api/settings',(req,res)=>{

  res.json({

    ...load(FILES.settings,{}),

    provider:process.env.PROVIDER||'auto',

    model:
      process.env.MODEL||
      'gemini-3.8-flash',

    hasModelKey:Boolean(
      process.env.GEMINI_API_KEY||
      process.env.GROQ_API_KEY||
      process.env.HF_TOKEN||
      process.env.OPENAI_API_KEY||
      process.env.API_KEY||
      process.env.PROVIDER==='ollama'
    ),

    hasRcon:Boolean(
      process.env.RCON_HOST&&
      process.env.RCON_PASSWORD
    ),

    protected:Boolean(APP_PASSWORD)
  });
});


app.post('/api/settings',(req,res)=>{

  const s=load(
    FILES.settings,
    {}
  );

  save(
    FILES.settings,
    {
      ...s,
      ...req.body
    }
  );

  res.json({
    ok:true
  });
});


/* MEMORY */

app.get('/api/memory',(req,res)=>
  res.json(
    load(FILES.memory,[]).reverse()
  )
);

app.delete('/api/memory',(req,res)=>{

  save(
    FILES.memory,
    []
  );

  res.json({
    ok:true
  });
});

app.post('/api/memory',(req,res)=>{

  if(!req.body.text)
    return res.status(400).json({
      error:'text required'
    });

  res.json(
    remember(
      req.body.text,
      'manual'
    )
  );
});


/* FILES */

app.get('/api/files',(req,res)=>
  res.json(
    load(FILES.files,[]).reverse()
  )
);


app.post(
  '/api/files',
  upload.array('files',8),
  async(req,res)=>{

    try{

      const all=load(
        FILES.files,
        []
      );

      const added=[];


      for(const f of req.files||[]){

        let extracted='';

        try{
          extracted=await extractFile(f);
        }catch{}


        const item={
          id:randomUUID(),
          name:f.originalname,
          mime:f.mimetype,
          size:f.size,
          path:f.path,
          extracted,
          createdAt:Date.now()
        };


        all.push(item);


        added.push({
          id:item.id,
          name:item.name,
          size:item.size,
          hasText:Boolean(extracted)
        });
      }


      save(
        FILES.files,
        all.slice(-200)
      );


      res.json({
        ok:true,
        files:added
      });

    }catch(e){

      res.status(500).json({
        error:e.message
      });
    }
  }
);


app.delete('/api/files/:id',(req,res)=>{

  const all=load(
    FILES.files,
    []
  );

  const f=all.find(
    x=>x.id===req.params.id
  );

  if(f)
    try{
      fs.unlinkSync(f.path);
    }catch{}


  save(
    FILES.files,
    all.filter(
      x=>x.id!==req.params.id
    )
  );


  res.json({
    ok:true
  });
});


/* PROJECTS */

app.get('/api/projects',(req,res)=>
  res.json(
    load(
      FILES.projects,
      []
    ).sort(
      (a,b)=>b.updatedAt-a.updatedAt
    )
  )
);


app.post('/api/projects',(req,res)=>{

  const all=load(
    FILES.projects,
    []
  );

  const x={
    id:randomUUID(),
    name:String(
      req.body.name||
      'Новый проект'
    ).slice(0,80),
    description:String(
      req.body.description||
      ''
    ),
    createdAt:Date.now(),
    updatedAt:Date.now()
  };


  all.push(x);


  save(
    FILES.projects,
    all.slice(-100)
  );


  res.json(x);
});


app.patch('/api/projects/:id',(req,res)=>{

  const all=load(
    FILES.projects,
    []
  );

  const x=all.find(
    p=>p.id===req.params.id
  );


  if(!x)
    return res.status(404).json({
      error:'project not found'
    });


  if(req.body.name!=null)
    x.name=String(
      req.body.name
    ).slice(0,80);


  if(req.body.description!=null)
    x.description=String(
      req.body.description
    );


  x.updatedAt=Date.now();


  save(
    FILES.projects,
    all
  );


  res.json(x);
});


app.delete('/api/projects/:id',(req,res)=>{

  save(
    FILES.projects,
    load(FILES.projects,[])
      .filter(
        p=>p.id!==req.params.id
      )
  );


  res.json({
    ok:true
  });
});


/* CHATS */

app.get('/api/chats',(req,res)=>
  res.json(
    load(FILES.chats,[])
      .map(x=>({
        id:x.id,
        title:x.title,
        updatedAt:x.updatedAt
      }))
      .sort(
        (a,b)=>b.updatedAt-a.updatedAt
      )
      .slice(0,100)
  )
);


app.post('/api/chats',(req,res)=>{

  const all=load(
    FILES.chats,
    []
  );

  const x={
    id:randomUUID(),
    title:req.body.title||'Новый чат',
    projectId:req.body.projectId||null,
    messages:[],
    createdAt:Date.now(),
    updatedAt:Date.now()
  };


  all.push(x);


  save(
    FILES.chats,
    all.slice(-200)
  );


  res.json(x);
});


app.get('/api/chats/:id',(req,res)=>{

  const x=load(
    FILES.chats,
    []
  ).find(
    x=>x.id===req.params.id
  );


  if(!x)
    return res.status(404).json({
      error:'chat not found'
    });


  res.json(x);
});


app.delete('/api/chats/:id',(req,res)=>{

  save(
    FILES.chats,
    load(FILES.chats,[])
      .filter(
        x=>x.id!==req.params.id
      )
  );


  res.json({
    ok:true
  });
});


/* CHAT */

app.post('/api/chat',async(req,res)=>{

  try{

    const message=String(
      req.body.message||''
    ).trim();


    if(!message)
      return res.status(400).json({
        error:'message required'
      });


    let chatId=req.body.chatId;


    const all=load(
      FILES.chats,
      []
    );


    let chat=all.find(
      x=>x.id===chatId
    );


    if(!chat){

      chat={
        id:randomUUID(),
        title:message.slice(0,60),
        projectId:req.body.projectId||null,
        messages:[],
        createdAt:Date.now(),
        updatedAt:Date.now()
      };

      all.push(chat);

      chatId=chat.id;
    }


    const history=
      Array.isArray(req.body.messages)
        ?req.body.messages
          .slice(-30)
          .filter(
            x=>x.role&&x.content
          )
        :chat.messages.slice(-30);


    history.push({
      role:'user',
      content:message
    });


    const out=await agent(history);


    chat.messages.push(

      {
        role:'user',
        content:message,
        createdAt:Date.now()
      },

      {
        role:'assistant',
        content:out.reply,
        tools:out.used,
        createdAt:Date.now()
      }

    );


    chat.updatedAt=Date.now();


    save(
      FILES.chats,
      all.slice(-200)
    );


    res.json({
      chatId,
      reply:out.reply,
      tools:out.used
    });

  }catch(e){

    res.status(500).json({
      error:e.message
    });
  }
});


/* IMAGE ANALYSIS */

app.post(
  '/api/analyze-image',
  upload.single('image'),
  async(req,res)=>{

    try{

      if(!req.file)
        return res.status(400).json({
          error:'image required'
        });


      const data=
        `data:${
          req.file.mimetype||
          'image/png'
        };base64,${
          fs.readFileSync(
            req.file.path
          ).toString('base64')
        }`;


      const reply=await modelRequest(

        [
          {
            role:'system',
            content:SYSTEM
          },

          {
            role:'user',
            content:String(
              req.body.prompt||
              'Подробно проанализируй изображение.'
            )
          }
        ],

        {
          toolChoice:'none',
          visionData:data
        }

      );


      try{
        fs.unlinkSync(
          req.file.path
        );
      }catch{}


      res.json({
        reply:
          reply.content||
          'Пустой ответ'
      });

    }catch(e){

      res.status(500).json({
        error:e.message
      });
    }
  }
);


/* RCON */

app.post('/api/rcon',async(req,res)=>{

  let r;

  try{

    if(!APP_PASSWORD)
      throw Error(
        'Для RCON включи APP_PASSWORD в настройках сервера.'
      );


    if(
      !process.env.RCON_HOST||
      !process.env.RCON_PASSWORD
    )
      throw Error(
        'RCON не настроен'
      );


    r=await Rcon.connect({
      host:process.env.RCON_HOST,
      port:Number(
        process.env.RCON_PORT||25575
      ),
      password:process.env.RCON_PASSWORD
    });


    const response=await r.send(
      String(
        req.body.command||''
      )
    );


    await r.end();


    res.json({
      ok:true,
      response
    });

  }catch(e){

    try{
      await r?.end();
    }catch{}


    res.status(500).json({
      error:e.message
    });
  }
});


app.use((req,res)=>
  res.sendFile(
    path.join(
      dir,
      'public',
      'index.html'
    )
  )
);


const port=Number(
  process.env.PORT||3000
);


app.listen(
  port,
  ()=>console.log(
    `TIMBLOGPLAY AI MULTI-PROVIDER running on ${port}`
  )
);
