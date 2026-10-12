from pathlib import Path
p=Path('src/app/App.tsx')
s=p.read_text(encoding='utf-8')
for name in ['TopBar','Timeline','ScenarioSelector','DeviceCard','Legend','VolumePanel','ReleaseProfilePanel','EventList','StatusBar']:
    s=s.replace(f"import {name} from '../ui/{name}';\n",'')
s=s.replace("import AlarmBanner", "import { SimpleTopBar, SimpleDeviceCard, SceneTools, SimpleTimeline, CompactLegend } from '../ui/SimpleControls';\nimport ProfessionalPanel from '../ui/ProfessionalPanel';\nimport AlarmBanner")
s=s.replace('  const [disclaimerOpen', '  const [analysisOpen, setAnalysisOpen] = useState(false);\n  const closeAnalysis = useCallback(() => setAnalysisOpen(false), []);\n  const [disclaimerOpen')
for line in ['  const renderMode = useFireStore((s) => s.renderMode);','  const setSlicePlane = useFireStore((s) => s.setSlicePlane);','  const releaseProfileAvailable = useFireStore((s) => s.releaseProfile !== null);','  const closeEventListRef = useRef<HTMLDivElement>(null);']:
    s=s.replace(line,'')
s=s.replace('    let maxDataC = -Infinity;', '    let maxDataC = -Infinity;\n    let minDataC = Infinity;')
s=s.replace('      if (s.dataMaxC > maxDataC)', '      minDataC = Math.min(minDataC, s.dataMinC);\n      if (s.dataMaxC > maxDataC)')
s=s.replace('      maxDataC,','      maxDataC, minDataC,')
a=s.index('      <TopBar')
b=s.index('      <DisclaimerDrawer',a)
s=s[:a]+'''      <SimpleTopBar onAnalysis={() => setAnalysisOpen(true)} onHelp={openDisclaimer}/>
      <AlarmBanner/>
      <SceneTools/>
      {!analysisOpen && <SimpleDeviceCard/>}
      {showSlices && sliceDomain && !analysisOpen && <CompactLegend
        min={sliceDomain.minC} max={sliceDomain.maxC}
        bottomClipped={sliceDomain.minDataC < sliceDomain.minC}
        topClipped={sliceDomain.maxDataC > sliceDomain.maxC}/>} 
      {sliceLoading && <div className="loading-note" role="status">正在加载温度场…</div>}
      {patchCount === 0 && showSlices && !sliceLoading && <div className="loading-note" role="status">当前平面温度数据不可用</div>}
      {analysisOpen && <ProfessionalPanel onClose={closeAnalysis} onHelp={openDisclaimer} frameInfo={volumeFrameInfo}/>}
      {appMode === 'FDS_SCENARIO' && <BottomDock timeline={<SimpleTimeline/>}/>}
      <div className="scene-hint">拖动旋转 · 滚轮缩放 · 点击起火标记选择设备</div>
      <div className="purpose-note">科研可视化 · 非工程消防报警系统</div>

'''+s[b:]
p.write_text(s,encoding='utf-8')
p=Path('src/store/useFireStore.ts')
s=p.read_text(encoding='utf-8').replace('  showRoof: true,','  showRoof: false,').replace('  wallOpacity: 1,','  wallOpacity: 0.22,')
s=s.replace('      showVolume: false,','      showVolume: false,\n      volumeLoading: false,\n      alarmState: \'NORMAL\',\n      alarmCabinetId: null,\n      manualTriggered: false,\n      alarmEvents: [],')
s=s.replace('      // 切换工况释放旧缓存', "      if (get().activeScenarioId !== scenarioId) return;\n      // 切换工况释放旧缓存")
s=s.replace('      set({ sliceData: loaded, sliceLoading: false });', '      if (get().activeScenarioId === scenarioId && get().slicePlane === plane) set({ sliceData: loaded, sliceLoading: false });')
s=s.replace('      const err = e as ScenarioAccessError;\n      set({\n        datasetStatus: err.availability ??', '      if (get().activeScenarioId !== scenarioId) return;\n      const err = e as ScenarioAccessError;\n      set({\n        datasetStatus: err.availability ??')
s=s.replace('    const clamped = Math.min(Math.max(0, t), T_END_S);', '    if (!Number.isFinite(t)) return;\n    const clamped = Math.min(Math.max(0, t), T_END_S);')
s=s.replace('    if (d !== null) {', '    if (d !== null) {\n      if (!Number.isFinite(d) || d < 0) return;')
s=s.replace('    ).then(() => set({ sliceData: loaded, sliceLoading: false }));','    ).then(() => {\n      if (get().activeScenarioId === s.activeScenarioId && get().slicePlane === p) set({ sliceData: loaded, sliceLoading: false });\n    });')
s=s.replace('      set({ volumeData: { [meta.asset]: bin }', '      if (get().activeScenarioId !== s.activeScenarioId || !get().showVolume) return;\n      set({ volumeData: { [meta.asset]: bin }')
p.write_text(s,encoding='utf-8')
# 科学报警逻辑独立于任何面板是否挂载。当前报警仅来自当前时刻，未来卡单独展示。
s+='''

useFireStore.subscribe((state, previous) => {
  if (state.series === previous.series && state.currentTimeS === previous.currentTimeS && state.thresholds === previous.thresholds) return;
  if (state.manualTriggered || state.datasetStatus !== 'READY') return;
  const cabinet = state.cabinets.find(c => c.id === state.selectedCabinetId);
  if (!cabinet) return;
  const query = queryCabinetTemperature(state.series, state.currentTimeS);
  const level = classifyTemperature(query.valueC,
    cabinet.zone === 'HIGH' ? state.thresholds.highZoneWarningC : state.thresholds.warningC,
    cabinet.zone === 'HIGH' ? state.thresholds.highZoneAlarmC : state.thresholds.alarmC);
  const alarm = level === 'UNKNOWN' ? 'NORMAL' : level;
  if (alarm === state.alarmState) return;
  const event: AlarmEvent[] = alarm === 'NORMAL' || query.valueC === null ? [] : [{
    id: `alarm-${++alarmSeq}`, timeS: state.currentTimeS, cabinetId: cabinet.id,
    scenarioId: state.activeScenarioId ?? '', level: alarm, valueC: query.valueC, origin: 'FDS_COMPUTED',
  }];
  useFireStore.setState({alarmState: alarm, alarmCabinetId: alarm === 'NORMAL' ? null : cabinet.id,
    alarmEvents: [...event, ...state.alarmEvents].slice(0,60)});
});
'''
p.write_text(s,encoding='utf-8')
# 避免二级设备卡 Esc 清空工况。
p=Path('src/ui/DeviceCard.tsx');s=p.read_text(encoding='utf-8');a=s.index('  // Esc 关闭卡片');b=s.index('  const handlePlay',a);s=s[:a]+s[b:];s=s.replace('useCallback, useEffect','useCallback');p.write_text(s,encoding='utf-8')
