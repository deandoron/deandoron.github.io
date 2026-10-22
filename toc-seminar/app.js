'use strict';

const timezone = 'Asia/Jerusalem';
const format = (value, options) => new Intl.DateTimeFormat('en-GB', {timeZone: timezone, ...options}).format(new Date(value));
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

function icon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':'1.5', 'aria-hidden':'true'})) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', kind === 'clock' ? 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2' : 'M12 22s8-7.5 8-14a8 8 0 0 0-16 0c0 6.5 8 14 8 14ZM12 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z');
  svg.append(path);
  return svg;
}

const abstractDialog = document.getElementById('abstract-dialog');
const smallerText = document.getElementById('abstract-smaller');
const largerText = document.getElementById('abstract-larger');
let abstractTextSize = 20;

function resizeAbstract(change) {
  abstractTextSize = Math.max(16, Math.min(28, abstractTextSize + change));
  abstractDialog.style.setProperty('--abstract-size', `${abstractTextSize}px`);
  smallerText.disabled = abstractTextSize === 16;
  largerText.disabled = abstractTextSize === 28;
  document.getElementById('abstract-size-status').textContent = `Abstract text size: ${abstractTextSize} pixels.`;
}

function openAbstract(event) {
  document.getElementById('abstract-title').textContent = event.title || event.speaker || 'Seminar abstract';
  const speaker = document.getElementById('abstract-speaker');
  speaker.textContent = (event.title ? [event.speaker, event.affiliation] : [event.affiliation]).filter(Boolean).join(' · ');
  speaker.hidden = !speaker.textContent;
  document.getElementById('abstract-text').textContent = event.abstract;
  resizeAbstract(0);
  abstractDialog.showModal();
  abstractDialog.scrollTop = 0;
  document.documentElement.classList.add('abstract-open');
}

smallerText.addEventListener('click', () => resizeAbstract(-2));
largerText.addEventListener('click', () => resizeAbstract(2));
document.getElementById('abstract-close').addEventListener('click', () => abstractDialog.close());
abstractDialog.addEventListener('close', () => document.documentElement.classList.remove('abstract-open'));
abstractDialog.addEventListener('click', event => {
  if (event.target !== abstractDialog) return;
  const bounds = abstractDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) abstractDialog.close();
});

function eventElement(event, featured, isPast = false) {
  const article = make('article', featured ? 'event featured' : 'event');
  const date = make('time', 'date');
  date.dateTime = event.start;
  date.append(make('span', 'month', format(event.start, {month:'short', year:'numeric'})), make('span', 'day', format(event.start, {day:'2-digit'})), make('span', 'weekday', format(event.start, {weekday:'long'})));
  const content = make('div', 'event-content');
  if (featured) content.append(make('span', 'next-label', Date.parse(event.start) <= Date.now() ? 'In progress' : 'Next seminar'));
  const heading = make('h3', '', event.title || event.speaker || (isPast ? 'Seminar' : 'Seminar — title to be announced'));
  heading.dir = 'auto';
  content.append(heading);
  if (event.speaker && event.title) {
    const speaker = make('p', 'speaker', event.speaker);
    if (event.affiliation) speaker.append(make('span', 'separator', ' · '), make('span', 'affiliation', event.affiliation));
    content.append(speaker);
  } else if (event.affiliation) {
    content.append(make('p', 'speaker affiliation', event.affiliation));
  }
  const metadata = make('div', 'metadata');
  const hours = {hour:'2-digit', minute:'2-digit', hourCycle:'h23'};
  const crossDay = format(event.start, {year:'numeric',month:'2-digit',day:'2-digit'}) !== format(event.end, {year:'numeric',month:'2-digit',day:'2-digit'});
  const end = crossDay ? format(event.end, {day:'numeric',month:'short',...hours}) : format(event.end, hours);
  const time = make('span', '', event.allDay ? 'All day' : `${format(event.start, hours)}–${end}`);
  time.prepend(icon('clock'));
  const location = make('span');
  const locationText = make('bdi', '', event.location || (isPast ? 'Location not listed' : 'Location to be announced'));
  location.append(locationText);
  location.prepend(icon('pin'));
  metadata.append(time, location);
  content.append(metadata);
  if (typeof event.abstract === 'string' && event.abstract.trim()) {
    const preview = make('div', 'abstract-preview');
    const details = make('details');
    const abstract = make('p', 'abstract', event.abstract);
    abstract.dir = 'auto';
    details.append(make('summary', '', 'Abstract'), abstract);
    const expand = make('button', 'expand-abstract', 'Expand abstract');
    expand.type = 'button';
    expand.setAttribute('aria-haspopup', 'dialog');
    expand.setAttribute('aria-controls', 'abstract-dialog');
    expand.setAttribute('aria-label', `Expand abstract: ${event.title || event.speaker || 'Seminar'}`);
    expand.addEventListener('click', () => openAbstract(event));
    preview.append(details, expand);
    content.append(preview);
  } else {
    content.append(make('p', 'talk-status', isPast ? 'Abstract not available.' : (event.title ? 'Abstract to be announced.' : 'Title and abstract to be announced.')));
  }
  article.append(date, content);
  return article;
}

let scheduleData;
let transitionTimer;

function renderSchedule(data) {
  const status = document.getElementById('status');
  const hasOffset = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const events = data.events.filter(event => !event.cancelled && !['private','confidential'].includes(event.sensitivity) && hasOffset(event.start) && hasOffset(event.end) && Number.isFinite(Date.parse(event.start)) && Number.isFinite(Date.parse(event.end)) && Date.parse(event.end) > Date.parse(event.start)).sort((a,b) => Date.parse(a.start)-Date.parse(b.start));
  const now = Date.now();
  const upcoming = events.filter(event => Date.parse(event.end) > now);
  const past = events.filter(event => Date.parse(event.end) <= now).reverse();
  document.getElementById('events').replaceChildren(...upcoming.map((event, index) => eventElement(event, index === 0)));
  status.hidden = upcoming.length > 0;
  status.textContent = data.updatedAt ? 'No upcoming seminars are currently listed. Please check back soon.' : 'The seminar schedule will be announced here soon.';
  document.getElementById('past-events').replaceChildren(...past.map(event => eventElement(event, false, true)));
  const pastStatus = document.getElementById('past-status');
  pastStatus.hidden = past.length > 0;
  pastStatus.textContent = 'No past seminars are listed yet.';
  const updated = document.getElementById('updated');
  updated.hidden = true;
  if (data.updatedAt && Number.isFinite(Date.parse(data.updatedAt))) {
    const stale = now - Date.parse(data.updatedAt) > 48 * 60 * 60 * 1000;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt);
    const updatedFormat = {day:'numeric',month:'long',year:'numeric',...(dateOnly ? {} : {hour:'2-digit',minute:'2-digit',hourCycle:'h23'})};
    updated.textContent = `${stale ? 'Schedule may be out of date. ' : ''}${data.source === 'manual-export' ? 'Schedule as of ' : 'Last updated '}${format(data.updatedAt, updatedFormat)}${dateOnly ? '.' : ' (Israel time).'}`;
    updated.hidden = false;
  }
  // Move talks when they end, including while the page stays open.
  clearTimeout(transitionTimer);
  const nextChange = Math.min(...events.flatMap(event => [Date.parse(event.start), Date.parse(event.end)]).filter(time => time > now));
  if (Number.isFinite(nextChange)) {
    transitionTimer = setTimeout(() => renderSchedule(data), Math.min(nextChange - now, 24 * 60 * 60 * 1000));
  }
}

async function loadSchedule() {
  const status = document.getElementById('status');
  try {
    let data = window.SEMINAR_SNAPSHOT_DATA;
    if (!data) {
      const response = await fetch('events.json', {cache:'no-cache'});
      if (!response.ok) throw new Error('Schedule unavailable');
      data = await response.json();
    }
    if (!Array.isArray(data.events)) throw new Error('Invalid schedule');
    scheduleData = data;
    renderSchedule(data);
  } catch {
    status.hidden = false;
    status.textContent = 'The schedule is temporarily unavailable. Please try again later or contact deand@bgu.ac.il for details.';
    const pastStatus = document.getElementById('past-status');
    pastStatus.hidden = false;
    pastStatus.textContent = 'Past seminars are temporarily unavailable.';
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && scheduleData) renderSchedule(scheduleData);
});
loadSchedule();
