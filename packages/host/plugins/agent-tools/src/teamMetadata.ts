/** Guest output is untrusted; retain only bounded public team/session metadata. */
export function projectTeamMetadata(input: unknown) {
  const row = object(input);
  if ((row.source !== 'unavailable' && row.source !== 'optional-omo-adapter') || (typeof row.enabled !== 'boolean' && row.enabled !== null)
    || typeof row.truncated !== 'boolean' || typeof row.unreadable !== 'boolean' || !Array.isArray(row.teams) || row.teams.length > 80) throw Error('Invalid team metadata');
  let remaining = 80;
  const teams = row.teams.map((raw: unknown) => {
    const team = object(raw);
    if (!Array.isArray(team.members) || team.members.length > remaining) throw Error('Invalid team members');
    remaining -= team.members.length;
    const members = team.members.map((rawMember: unknown) => { const member=object(rawMember); return {sessionId: sessionId(member.sessionId),status: status(member.status)}; });
    if (typeof team.modifiedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(team.modifiedAt) || !Number.isFinite(Date.parse(team.modifiedAt))) throw Error('Invalid team observation');
    return {leadSessionId: sessionId(team.leadSessionId),status: status(team.status),members,modifiedAt:team.modifiedAt};
  });
  return {source:row.source,enabled:row.enabled,truncated:row.truncated,unreadable:row.unreadable,teams};
}
function object(value: unknown): Record<string,unknown> { if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid team metadata');return Object.fromEntries(Object.entries(value)); }
function sessionId(value: unknown) { if(value===null)return null;if(typeof value==='string'&&/^ses_[A-Za-z0-9]{1,100}$/.test(value))return value;throw Error('Invalid session identity'); }
function status(value: unknown) {return typeof value==='string'&&['active','running','creating','shutdown_requested','idle','busy','retry','errored','error','completed','stopped','pending','failed','shutdown','deleting','deleted'].includes(value)?value:'unknown';}
