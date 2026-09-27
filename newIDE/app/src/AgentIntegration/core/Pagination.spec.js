// @flow
import { makeBoundedPagination, makeOffsetPagination } from './Pagination';

describe('Pagination contract', () => {
  it('returns one canonical offset pagination shape with truthful continuation', () => {
    expect(
      makeOffsetPagination({
        offset: 20,
        limit: 10,
        total: 35,
        returned: 10,
      })
    ).toEqual({
      mode: 'offset',
      offset: 20,
      limit: 10,
      total: 35,
      returned: 10,
      hasMore: true,
      truncated: true,
      nextOffset: 30,
    });

    expect(
      makeOffsetPagination({
        offset: 30,
        limit: 10,
        total: 35,
        returned: 5,
      })
    ).toEqual({
      mode: 'offset',
      offset: 30,
      limit: 10,
      total: 35,
      returned: 5,
      hasMore: false,
      truncated: false,
      nextOffset: null,
    });
  });

  it('reports bounded truncation without inventing a cursor', () => {
    expect(
      makeBoundedPagination({
        limit: 2,
        total: 5,
        returned: 2,
      })
    ).toEqual({
      mode: 'bounded',
      limit: 2,
      total: 5,
      returned: 2,
      hasMore: true,
      truncated: true,
      nextCursor: null,
    });

    expect(
      makeBoundedPagination({
        limit: 10,
        total: 3,
        returned: 3,
      })
    ).toEqual({
      mode: 'bounded',
      limit: 10,
      total: 3,
      returned: 3,
      hasMore: false,
      truncated: false,
      nextCursor: null,
    });
  });

  it('never invents a continuation from an empty out-of-range page', () => {
    expect(
      makeOffsetPagination({
        offset: 100,
        limit: 10,
        total: 35,
        returned: 0,
      })
    ).toMatchObject({
      hasMore: false,
      truncated: false,
      nextOffset: null,
    });
  });
});
