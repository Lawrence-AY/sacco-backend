const EAT_TIME_ZONE = 'Africa/Nairobi';

const formatEAT = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EAT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((map, part) => ({ ...map, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} EAT`;
};

const withEAT = (record) => ({ ...record, createdAtEAT: formatEAT(record.createdAt), updatedAtEAT: formatEAT(record.updatedAt) });
module.exports = { EAT_TIME_ZONE, formatEAT, withEAT };
