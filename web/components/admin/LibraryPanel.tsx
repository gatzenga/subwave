'use client';

import { useEffect } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import TaggingPanel from './LibraryTaggingPanel';
import { LibraryProvider, useLibrary } from './library/LibraryContext';
import { useLibraryUrlState } from './library/useLibraryUrlState';
import { useTaggerControls } from './library/useTaggerControls';
import BrowseTab from './library/tabs/BrowseTab';
import SearchTab from './library/tabs/SearchTab';
import TracksTab from './library/tabs/TracksTab';
import HistoryTabContainer from './library/tabs/HistoryTabContainer';
import BlockedTabContainer from './library/tabs/BlockedTabContainer';
import { Tabs } from './library/Tabs';
import { BlockSelectedBar } from './library/BlockSelectedBar';

export default function LibraryPanel() {
  return <LibraryPanelInner />;
}

// Owns the Library feature boundary. Split from the body so every tab consumes
// the same LibraryProvider while useAdminAuth mirrors the shell's shared store.
function LibraryPanelInner() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  return (
    <LibraryProvider adminFetch={adminFetch} ready={hydrated && !needsAuth}>
      <LibraryBody />
    </LibraryProvider>
  );
}

function LibraryBody() {
  const { clearSelection, selected, plBusy, blockSelectedTracks } = useLibrary();

  // Tab, browse filters and the search query live in the query string; the
  // hook owns the restore-on-mount and write-back effects.
  const {
    tab, setTab, trackMode, setTrackMode,
    moods, setMoods, energy, setEnergy, vocal, setVocal, genre, setGenre,
    yearFrom, setYearFrom, yearTo, setYearTo, q, setQ, sort, setSort,
    searchQuery, setSearchQuery, searchMode, setSearchMode,
    restored: urlRestored,
  } = useLibraryUrlState();

  const tag = useTaggerControls();

  // A lean analyzer can't serve sound search, so fall back to metadata mode —
  // the toggle that would switch back is hidden in that case.
  useEffect(() => {
    if (tag.coverage && tag.coverage.soundSearchAvailable !== true && searchMode === 'sound') {
      setSearchMode('library');
    }
  }, [tag.coverage, searchMode, setSearchMode]);

  // Selection is per-view: ids from another tab would be invisible, and
  // "Add 12" with 9 off-screen rows is a foot-gun. Lives here rather than in
  // the provider because only the panel knows the tab changed.
  useEffect(() => { clearSelection(); }, [tab, clearSelection]);

  return (
    // grid-cols-1: the implicit `auto` track is sized by min-content, so a
    // doorway card's un-shrinkable copy blew the column past a phone viewport.
    <div className="grid grid-cols-1 gap-5">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      </div>

      <TaggingPanel
        coverage={tag.coverage}
        libStats={tag.libStats}
        tagger={tag.tagger}
        batch={tag.batch}
        setBatch={tag.setBatch}
        busy={tag.busy}
        logOpen={tag.logOpen}
        setLogOpen={tag.setLogOpen}
        onStart={tag.startTagger}
        onStop={tag.stopTagger}
        onRescan={tag.rescanTagger}
        onReconcile={tag.reconcile}
        onCountLibrary={tag.countLibrary}
        countingLibrary={tag.countingLibrary}
        onReset={tag.resetLibrary}
        audioEnabled={tag.audioEnabled}
        onToggleAudio={tag.toggleAudio}
        onAnalyzeAudio={tag.analyzeAudio}
        vocalEnabled={tag.vocalEnabled}
        onToggleVocal={tag.toggleVocal}
        onVocalBackfill={tag.vocalBackfill}
        quietEnabled={tag.quietEnabled}
        quietMinutes={tag.quietMins}
        onToggleQuiet={tag.toggleQuiet}
        onQuietMinutes={tag.saveQuietMinutes}
        budgetMode={tag.budgetMode}
        llmLabel={tag.llmLabel}
        embedLabel={tag.embedLabel}
        failures={tag.failures}
        onLoadFailures={tag.loadFailures}
        onClearFailures={tag.clearFailures}
      />

      <Tabs tab={tab} setTab={setTab} />

      {tab === 'browse' && (
        <BrowseTab
          moods={moods} setMoods={setMoods}
          energy={energy} setEnergy={setEnergy}
          vocal={vocal} setVocal={setVocal}
          genre={genre} setGenre={setGenre}
          yearFrom={yearFrom} setYearFrom={setYearFrom}
          yearTo={yearTo} setYearTo={setYearTo}
          q={q} setQ={setQ}
          sort={sort} setSort={setSort}
          libStats={tag.libStats}
        />
      )}

      {tab === 'search' && (
        <SearchTab
          searchQuery={searchQuery} setSearchQuery={setSearchQuery}
          searchMode={searchMode} setSearchMode={setSearchMode}
          urlRestored={urlRestored}
        />
      )}

      {tab !== 'blocked' && tab !== 'history' && selected.size > 0 && (
        <BlockSelectedBar
          count={selected.size}
          busy={plBusy}
          onBlock={blockSelectedTracks}
          onClear={clearSelection}
        />
      )}

      {tab === 'blocked' && <BlockedTabContainer />}

      {tab === 'history' && <HistoryTabContainer />}

      {tab === 'tracks' && (
        <TracksTab
          trackMode={trackMode}
          setTrackMode={setTrackMode}
          remaining={tag.remaining}
          onTagAll={() => tag.startTagger()}
          taggerRunning={!!tag.tagger?.running}
          taggerBusy={tag.busy}
        />
      )}

    </div>
  );
}
