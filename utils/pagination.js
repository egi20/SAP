'use strict';

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

/**
 * Normalise `?page=` / `?per_page=` into LIMIT/OFFSET values.
 * Everything is clamped, so a hand-crafted `per_page=100000` cannot turn a list view
 * into a full table scan.
 */
function paginationFrom(query, { defaultPerPage = DEFAULT_PER_PAGE } = {}) {
  const rawPage = parseInt(query.page, 10);
  const rawPerPage = parseInt(query.per_page, 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10000) : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, MAX_PER_PAGE) : defaultPerPage;

  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

/** Build the view model a paginator partial needs. */
function paginationMeta({ page, perPage, total }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return {
    page,
    perPage,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    from: total === 0 ? 0 : (page - 1) * perPage + 1,
    to: Math.min(page * perPage, total)
  };
}

/**
 * Rebuild a query string with `page` replaced, preserving every other filter.
 * Used by the paginator links so filters survive paging.
 */
function pageUrl(basePath, query, page) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (key === 'page' || value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value.filter((v) => v !== '').forEach((v) => params.append(key, v));
    } else {
      params.append(key, value);
    }
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

module.exports = { paginationFrom, paginationMeta, pageUrl, DEFAULT_PER_PAGE, MAX_PER_PAGE };
