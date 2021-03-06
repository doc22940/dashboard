import {
  call,
  put,
  takeEvery,
  select,
  spawn,
  take,
} from "redux-saga/effects"
import { channel } from "redux-saga"
import { Action } from "redux-act"

import { axiosInstance } from "utils/api"
import { alwaysEndWithSlash } from "utils/server-detection"
import { getFetchStream } from "utils/netdata-sdk"

import { selectGlobalPanAndZoom, selectSnapshot } from "domains/global/selectors"
import { StateT as GlobalStateT } from "domains/global/reducer"
import { stopSnapshotModeAction } from "domains/dashboard/actions"

import {
  fetchDataAction, FetchDataPayload,
  fetchChartAction, FetchChartPayload,
  fetchDataForSnapshotAction, FetchDataForSnapshotPayload,
} from "./actions"

const CONCURRENT_CALLS_LIMIT_METRICS = 20
const CONCURRENT_CALLS_LIMIT_SNAPSHOTS = 1

const fetchDataResponseChannel = channel()

export function* watchFetchDataResponseChannel() {
  while (true) {
    const action = (yield take(fetchDataResponseChannel))

    // special case - if requested relative timeRange, and during request the mode has been changed
    // to absolute global-pan-and-zoom, cancel the store update
    // todo do xss check of data
    if (action.type === fetchDataAction.success.toString()) {
      const { viewRange } = action.payload.fetchDataParams
      const [start, end] = viewRange
      const globalPanAndZoom = (yield select(
        selectGlobalPanAndZoom,
      )) as GlobalStateT["globalPanAndZoom"]

      if (globalPanAndZoom
        && (start <= 0 || end <= 0) // check if they are not timestamps
      ) {
        // eslint-disable-next-line no-continue
        continue
      }
    }

    yield put(action)
  }
}

// todo construct a new version of key that will be safer to be used in future
// (while keeping old key supported for some time)
// perhaps the key could be passed as attribute to the chart, to avoid matching
const constructCompatibleKey = (dimensions: undefined | string, options: string) => (
  // strange transformations for backwards compatibility. old snapshot keys were encoded this way
  // that empty dimensions were actually "null" string
  `${dimensions === undefined
    ? "null"
    : encodeURIComponent(dimensions)
  },${encodeURIComponent(options)}`
)

const [fetchMetrics$] = getFetchStream(CONCURRENT_CALLS_LIMIT_METRICS)
function* fetchDataSaga({ payload }: Action<FetchDataPayload>) {
  const {
    // props for api
    host, chart, format, points, group, gtime, options, after, before, dimensions,
    // props for the store
    fetchDataParams, id,
  } = payload

  const snapshot = yield select(selectSnapshot)
  if (snapshot) {
    // if reading snapshot
    const dimensionsWithUrlOptions = constructCompatibleKey(dimensions, options)
    const matchingKey = Object.keys(snapshot.data).find((snapshotKey) => (
      snapshotKey.startsWith(chart) && snapshotKey.includes(dimensionsWithUrlOptions)
    ))
    if (!matchingKey) {
      // eslint-disable-next-line no-console
      console.warn(`Could not find snapshot key for chart: ${chart} and id ${id}`)
      return
    }
    const data = snapshot.data[matchingKey]
    yield put(fetchDataAction.success({
      chartData: data,
      fetchDataParams,
      id,
    }))
    return
  }

  const url = `${alwaysEndWithSlash(host)}api/v1/data`

  const params = {
    chart,
    _: new Date().valueOf(),
    format,
    points,
    group,
    gtime,
    options,
    after,
    before,
    dimensions,
  }

  const onSuccessCallback = (data: unknown) => {
    fetchDataResponseChannel.put(fetchDataAction.success({
      chartData: data,
      fetchDataParams,
      id,
    }))
  }

  const onErrorCallback = () => {
    console.warn("fetch chart data failure") // eslint-disable-line no-console
    fetchDataResponseChannel.put(fetchDataAction.failure({ id }))
  }


  fetchMetrics$.next({
    url,
    params,
    onErrorCallback,
    onSuccessCallback,
  })
}

const [fetchForSnapshot$, resetFetchForSnapshot$] = getFetchStream(CONCURRENT_CALLS_LIMIT_SNAPSHOTS)
function fetchDataForSnapshotSaga({ payload }: Action<FetchDataForSnapshotPayload>) {
  const {
    host, chart, format, points, group, gtime, options, after, before, dimensions,
    chartLibrary, id,
  } = payload

  // backwards-compatibility, the keys look like this:
  // net_errors.stf0,dygraph,null,ms%7Cflip%7Cjsonwrap%7Cnonzero
  const chartDataUniqueID = `${chart},${chartLibrary},${constructCompatibleKey(
    dimensions,
    options,
  )}`

  const url = `${alwaysEndWithSlash(host)}api/v1/data`
  const params = {
    chart,
    _: new Date().valueOf(),
    format,
    points,
    group,
    gtime,
    options,
    after,
    before,
    dimensions,
  }

  const onSuccessCallback = (data: unknown) => {
    fetchDataResponseChannel.put(fetchDataForSnapshotAction.success({
      snapshotData: data,
      id,
    }))
    // temporarly, until main.js finished rewrite
    // @ts-ignore
    window.chartUpdated({
      chartDataUniqueID,
      data,
    })
  }

  const onErrorCallback = () => {
    fetchDataResponseChannel.put(fetchDataForSnapshotAction.failure({ id }))
    // @ts-ignore
    window.chartUpdated({
      chartDataUniqueID,
      chart,
      data: null,
    })
  }

  fetchForSnapshot$.next({
    url,
    params,
    onErrorCallback,
    onSuccessCallback,
  })
}

function stopSnapshotModeSaga() {
  // any calls in the queue should stop when save-snapshot modal is closed
  resetFetchForSnapshot$.next()
}

function* fetchChartSaga({ payload }: Action<FetchChartPayload>) {
  const { chart, id, host } = payload

  const snapshot = yield select(selectSnapshot)
  if (snapshot) {
    yield put(fetchChartAction.success({
      chartDetails: snapshot.charts.charts[chart],
      id,
    }))
    return
  }

  let response
  const url = `${alwaysEndWithSlash(host)}api/v1/chart`
  try {
    response = yield call(axiosInstance.get, url, {
      params: {
        chart,
      },
    })
  } catch (e) {
    console.warn("fetch chart details failure") // eslint-disable-line no-console
    yield put(fetchChartAction.failure({ id }))
    return
  }
  yield put(fetchChartAction.success({
    chartDetails: response.data,
    id,
  }))
}

export function* chartSagas() {
  yield takeEvery(fetchDataAction.request, fetchDataSaga)
  yield takeEvery(fetchChartAction.request, fetchChartSaga)
  yield takeEvery(fetchDataForSnapshotAction.request, fetchDataForSnapshotSaga)
  yield takeEvery(stopSnapshotModeAction, stopSnapshotModeSaga)

  yield spawn(watchFetchDataResponseChannel)
}
