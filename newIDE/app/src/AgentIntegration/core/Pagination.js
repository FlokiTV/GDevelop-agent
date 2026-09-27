// @flow

export type OffsetPagination = {|
  mode: 'offset',
  offset: number,
  limit: number,
  total: number,
  returned: number,
  hasMore: boolean,
  truncated: boolean,
  nextOffset: ?number,
|};

export type BoundedPagination = {|
  mode: 'bounded',
  limit: number,
  total: number,
  returned: number,
  hasMore: boolean,
  truncated: boolean,
  nextCursor: null,
|};

export const makeOffsetPagination = ({
  offset,
  limit,
  total,
  returned,
}: {|
  offset: number,
  limit: number,
  total: number,
  returned: number,
|}): OffsetPagination => {
  const normalizedOffset = Math.max(0, Math.round(Number(offset) || 0));
  const normalizedLimit = Math.max(1, Math.round(Number(limit) || 1));
  const normalizedTotal = Math.max(0, Math.round(Number(total) || 0));
  const normalizedReturned = Math.max(
    0,
    Math.min(normalizedLimit, Math.round(Number(returned) || 0))
  );
  const hasMore =
    normalizedOffset + normalizedReturned < normalizedTotal &&
    normalizedReturned > 0;
  return {
    mode: 'offset',
    offset: normalizedOffset,
    limit: normalizedLimit,
    total: normalizedTotal,
    returned: normalizedReturned,
    hasMore,
    truncated: hasMore,
    nextOffset: hasMore ? normalizedOffset + normalizedReturned : null,
  };
};

export const makeBoundedPagination = ({
  limit,
  total,
  returned,
}: {|
  limit: number,
  total: number,
  returned: number,
|}): BoundedPagination => {
  const normalizedLimit = Math.max(1, Math.round(Number(limit) || 1));
  const normalizedTotal = Math.max(0, Math.round(Number(total) || 0));
  const normalizedReturned = Math.max(
    0,
    Math.min(normalizedLimit, Math.round(Number(returned) || 0))
  );
  const hasMore = normalizedReturned < normalizedTotal;
  return {
    mode: 'bounded',
    limit: normalizedLimit,
    total: normalizedTotal,
    returned: normalizedReturned,
    hasMore,
    truncated: hasMore,
    nextCursor: null,
  };
};
