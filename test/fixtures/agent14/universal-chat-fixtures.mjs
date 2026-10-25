/** Fictional, sanitized U1 fixture. NOT evidence of a live provider or acceptance. */
export const snapshot = {
 id:'studio-local-conversation-1', site:{id:'fictional.webapp'}, state:'ready',
 account:{state:'signed-in'}, binding:{targetId:'tab-local-3',title:'Demo AI',thread:{key:'fictional-native-thread-9'}},
 identity:{state:'bound',threadKey:'fictional-native-thread-9'}, turn:{send:{state:'observed'}},
};
export const openTabs=[{id:'tab-local-3',title:'Demo AI',site:'fictional.webapp'}];
export const accountChats=[{threadRef:'fictional-native-thread-9',title:'Demo session',coverage:'partial'}];
export const adapters=[
 {site:'fictional.webapp',surface:'chat',source:'seed',version:'seed-1',stage:'unverified',seedVersion:'seed-1'},
 {site:'fictional.webapp',surface:'chat',source:'learned',version:'candidate-2',seedVersion:'seed-1',precedence:'seed-fallback',candidate:true,stage:'shadow',trainingSessionIds:['train-a','train-b'],heldoutSessionIds:['heldout-c'],trainingComplete:true,shadowResult:'mismatch',drift:'observed',rollbackVersion:'seed-1',coverage:.83,confidence:.71},
];
const ev=(turnId,blockId,eventId,sequence,op,kind,text,payload,revision)=>({turnId,blockId,eventId,sequence,op,kind,text,payload,revision});
export const events=[
 ev('user-1','text-1','e1',1,'open','text','Same short message',{},0),
 ev('assistant-1','code-1','e2',2,'open','code','console.log("hello")',{language:'js'},0),
 ev('assistant-1','code-1','e3',3,'close','code'),
 ev('assistant-1','artifact-1','e4',4,'open','artifact','Draft one',{title:'Report',version:1,status:'created',mediaType:'text/markdown'},0),
 ev('assistant-1','artifact-1','e5',5,'replace','artifact','Updated version',{title:'Report',version:2,status:'revised',mediaType:'text/markdown',versions:[{version:1,status:'superseded'},{version:2,status:'current'}]},1),
 ev('user-2','text-2','e6',6,'open','text','Same short message',{},0),
 ev('assistant-2','table-1','e7',7,'open','table','',{columns:['Name','Value'],rows:[['alpha','1']]},0),
 ev('assistant-2','unknown-1','e8',8,'open','native-widget','',{preview:'Untranslated native widget'},0),
 ev('assistant-2','progress-1','e9',9,'open','progress','',{label:'Research',percent:45},0),
 ev('assistant-2','tool-1','e10',10,'open','tool-activity-observed','',{tool:'Search',state:'shown by webpage'},0),
];
export const outcome={send:'observed',reply:'streaming',networkEnded:false,pageStable:false,freshReply:true,captureFinalized:false,captureAccepted:false,goalFulfilled:false};
