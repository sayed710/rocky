/**
 * Studies controller — a pure, DOM-free orchestrator for the studies viewer UI.
 *
 * Mirrors LearningController and AchievementsController: a `requestGeneration` stale-response guard,
 * `dispose()`, and a 503 latch (`onUnavailable`).
 *
 * Every studies endpoint answers 503 when `studiesRepository` is not configured on the API.
 * The controller latches on the first 503 and stops asking for the rest of this view.
 */
import type { GambitClient } from '../api/client.js';
import type {
  ChapterView,
  CollaboratorView,
  StudyView,
  TreeNodeView,
} from '../api/models.js';
import { ServiceUnavailableError } from '../net/errors.js';

export interface StudiesCallbacks {
  onStudyList: (studies: readonly StudyView[], total: number) => void;
  onStudy: (
    study: StudyView,
    chapters: readonly ChapterView[],
    collaborators: readonly CollaboratorView[],
    exportUrl: string,
  ) => void;
  onChapterDetail: (
    study: StudyView,
    chapter: ChapterView,
    tree: readonly TreeNodeView[],
    chapters: readonly ChapterView[],
    exportUrl: string,
  ) => void;
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
  onUnavailable: () => void;
}

export interface StudiesControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: StudiesCallbacks;
  readonly onDispose?: (() => void) | undefined;
}

export class StudiesController {
  private readonly client: GambitClient;
  private readonly callbacks: StudiesCallbacks;
  private readonly onDispose?: (() => void) | undefined;
  private requestGeneration = 0;
  private disposed = false;
  private unavailable = false;

  constructor(opts: StudiesControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.onDispose = opts.onDispose;
  }

  /**
   * Load the list of public and visible studies.
   */
  async loadStudies(search?: string): Promise<void> {
    if (this.disposed) return;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return;
    }
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const page = await this.client.studies.listStudies(search ? { search } : undefined);
      if (!this.isCurrent(generation)) return;
      this.callbacks.onStudyList(page.items, page.total);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(messageOf(err));
    } finally {
      if (generation === this.requestGeneration) this.callbacks.onLoading(false);
    }
  }

  /**
   * Load a study by id, plus its chapters and collaborators list.
   */
  async loadStudy(id: string): Promise<void> {
    if (this.disposed) return;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return;
    }
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const study = await this.client.studies.study(id);
      if (!this.isCurrent(generation)) return;

      const chaptersPage = await this.client.studies.chapters(id);
      if (!this.isCurrent(generation)) return;

      let collaborators: readonly CollaboratorView[] = [];
      try {
        const collabPage = await this.client.studies.collaborators(id);
        collaborators = collabPage.items;
      } catch (err) {
        if (err instanceof ServiceUnavailableError) throw err;
        // Collaborators are supplementary; if fetch fails, proceed with empty list
      }
      if (!this.isCurrent(generation)) return;

      const exportUrl = this.client.studies.exportPgnUrl(id);
      this.callbacks.onStudy(study, chaptersPage.items, collaborators, exportUrl);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(messageOf(err));
    } finally {
      if (generation === this.requestGeneration) this.callbacks.onLoading(false);
    }
  }

  /**
   * Load a chapter detail (chapter + flat tree) for a study, plus chapter list for navigation.
   */
  async loadChapter(studyId: string, chapterId: string): Promise<void> {
    if (this.disposed) return;
    if (this.unavailable) {
      this.callbacks.onUnavailable();
      return;
    }
    const generation = ++this.requestGeneration;
    this.callbacks.onLoading(true);
    try {
      const study = await this.client.studies.study(studyId);
      if (!this.isCurrent(generation)) return;

      const detail = await this.client.studies.chapterDetail(studyId, chapterId);
      if (!this.isCurrent(generation)) return;

      const chaptersPage = await this.client.studies.chapters(studyId);
      if (!this.isCurrent(generation)) return;

      const exportUrl = this.client.studies.exportPgnUrl(studyId, chapterId);
      this.callbacks.onChapterDetail(
        study,
        detail.chapter,
        detail.tree,
        chaptersPage.items,
        exportUrl,
      );
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      if (err instanceof ServiceUnavailableError) {
        this.unavailable = true;
        this.callbacks.onUnavailable();
        return;
      }
      this.callbacks.onError(messageOf(err));
    } finally {
      if (generation === this.requestGeneration) this.callbacks.onLoading(false);
    }
  }

  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
  }

  dispose(): void {
    this.disposed = true;
    this.onDispose?.();
  }

  /**
   * Whether `generation` may still *paint*. Disposal counts against it: a late response must not
   * write into a section the next route has already hidden.
   *
   * The `onLoading(false)` calls deliberately do not use this — they test the generation alone.
   * Clearing a busy flag is not painting, and gating it on `disposed` left `aria-busy="true"` on
   * the persistent markup when a navigation cancelled an in-flight load, so the hidden section
   * stayed announced as busy until something else happened to overwrite it.
   */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
