/** Formats an instant inside a report as `YYYY-MM-DD HH:MM <zone>` in the report's own time zone, never the browser's. */
export function formatReportInstant(iso:string,timeZone:string):string {
  const date=new Date(iso);
  if(Number.isNaN(date.getTime()))return iso;
  try {
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}`;
  } catch { return iso; }
}

/** Formats an instant relative to now in the browser's locale, such as "3 hours ago". */
export function formatRelativeInstant(iso:string):string {
  const seconds=(new Date(iso).getTime()-Date.now())/1000,rtf=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
  for(const [unit,size] of [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]] as const)if(Math.abs(seconds)>=size)return rtf.format(Math.round(seconds/size),unit);
  return rtf.format(Math.round(seconds),'second');
}
