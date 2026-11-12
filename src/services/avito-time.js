'use strict';

// Avito может возвращать Unix-время
// в секундах или миллисекундах.
function avitoDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  // Avito: секунды, секунды с двумя дробными
  // цифрами или стандартные миллисекунды.
  const milliseconds = timestamp >= 1e12
    ? timestamp
    : timestamp >= 1e11
      ? timestamp * 10
      : timestamp * 1000;

  const date = new Date(milliseconds);

  return Number.isFinite(date.getTime())
    ? date
    : null;
}

module.exports = { avitoDate };
