module Gtd.Command exposing
    ( ActionChanges
    , Command(..)
    , Disposition(..)
    , ImportKind(..)
    , InboxInput
    , MenuEntry(..)
    , NewActionInput
    , NewProjectInput
    , ProjectChanges
    , ScheduleInput(..)
    , encode
    , noInboxInput
    )

{-| Internal wire representation shared by the surface-specific command modules.

Entry points import `Gtd.Command.ActionBoard`, `Gtd.Command.Projects`, and the
other capability modules instead. Those smaller unions prevent one surface from
constructing a command owned by another while this module keeps JSON encoding in
one place.

-}

import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Checklist as Checklist exposing (MarkState)
import Gtd.Id exposing (ActionId, FeedItemKey, InboxItemId, ProjectId)
import Gtd.PomodoroOutcome as PomodoroOutcome exposing (PomodoroOutcome)
import Gtd.Energy as Energy exposing (Energy)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Settings as Settings exposing (SavedView)
import Json.Encode as Encode


type Command
    = -- Opening host surfaces
      OpenFile String
    | OpenInbox
    | QuickCapture
    | ShowProject ProjectId
    | SetProjectSelection (Maybe ProjectId)
    | Prompt { title : String, placeholder : String }
    | ShowMenu Float Float (List MenuEntry)
      -- Modals the host owns
    | NewActionModal (Maybe ProjectId)
    | NewProjectModal (Maybe ProjectId) ProjectStatus
    | EditActionModal ActionId
    | EditProjectModal ProjectId
    | ImportActionsModal ProjectId
    | ImportSubprojectsModal ProjectId
    | BatchProjectTagsModal (List ProjectId)
    | BatchProjectParentModal (List ProjectId)
    | ProjectDependenciesModal ProjectId
      -- Actions
    | SetActionStatus ActionId ActionStatus
    | SetActionPriorities (List ActionId)
    | SetActionContext ActionId String
    | TrashAction ActionId
    | CreateAction NewActionInput
    | UpdateAction ActionId ActionChanges
    | ScheduleAction ActionId ScheduleInput
    | ConvertActionToSubproject { actionId : ActionId, title : String, parentProjectId : ProjectId }
      -- Projects
    | SetProjectStatus ProjectId ProjectStatus
    | SetProjectArea ProjectId String
    | MoveSubproject ProjectId ProjectStatus (Maybe ProjectId)
    | TrashProject ProjectId
    | TrashProjects (List ProjectId)
    | CreateProject NewProjectInput
    | UpdateProject ProjectId ProjectChanges
    | AddProjectTags (List ProjectId) (List String)
    | SetProjectsParent (List ProjectId) (Maybe ProjectId)
    | SetProjectBlockers ProjectId (List ProjectId)
      -- Project detail
    | LoadProjectDetail ProjectId
    | SetDesiredOutcome ProjectId String
    | AddDiaryEntry ProjectId String
    | CreateSupportNote ProjectId String
    | CreateSupportFolder ProjectId String
    | LinkProjectFile ProjectId
    | UnlinkProjectFile ProjectId String
    | AddProjectLink ProjectId String String
    | RemoveProjectLink ProjectId String
    | ReadSupportNote ProjectId String
    | UpdateSupportNote ProjectId String String
    | SaveProjectPreferences
        { columns : List ProjectStatus
        , showImages : Bool
        , columnsBy : Settings.ProjectColumnsBy
        , sections : Settings.ProjectSections
        }
    | ReviewSomedayProject ProjectId String
    | OpenSomedayReview
      -- Agent delegation
    | DelegateProject ProjectId
    | AnswerAgentQuestion String String String
    | StopAgentRun String
    | RerunAgentRun String
    | DeleteAgentRun String
      -- Pomodoro
    | OpenPomodoro ProjectId
    | StartPomodoro { projectId : ProjectId, intention : String, focusActionIds : List ActionId, minutes : Int }
    | PausePomodoro
    | ResumePomodoro
    | FinishPomodoro (Maybe PomodoroOutcome) String
    | DiscardPomodoro
    | CompletePomodoroAction ActionId
    | StartChecklistPomodoro { path : String, intention : String, minutes : Int }
    | OpenChecklistPomodoro String
      -- Checklists
    | StartChecklistRun String
    | ShowChecklistRun (Maybe String)
    | OpenChecklistRun String
    | MarkChecklistItem { runId : String, key : String, state : MarkState }
    | FinishChecklistRun String
    | DiscardChecklistRun String
    | CaptureFromChecklist { path : String, text : String }
      -- Review
    | LoadReviewProject ProjectId
    | CreateReviewAction { title : String, projectId : ProjectId, context : String }
    | CompleteProjectReview ProjectId String (List ProjectId)
    | MoveReviewToSomeday ProjectId String (List ProjectId)
      -- Brainstorm
    | LoadBrainstormOutcome ProjectId
    | SaveBrainstorm ActionId String (Maybe String)
    | SaveStandaloneBrainstorm String String
    | ShuffleBrainstormWords
    | FocusBrainstormIdeas Int Int
    | SuggestBrainstormIdeas { topic : String, desiredOutcome : String, ideas : String, offered : List String }
      -- Feeds
    | RefreshFeeds
    | AddFeed
    | KeepFeedItems (List FeedItemKey)
    | ReadFeedItem FeedItemKey Bool
    | DiscardFeedItems (List FeedItemKey)
    | UndoFeedDiscard
    | OpenLink String
    | OpenNoteLink String String
      -- Inbox
    | ReadInboxBody InboxItemId
    | ReadDesiredOutcome ProjectId
    | ShowProjectIssues
    | TrashInboxItem InboxItemId
    | OpenMail InboxItemId
    | ReviewPullRequest InboxItemId
    | ProcessInbox InboxItemId Disposition InboxInput
    | CaptureInboxItem String
      -- Pasted lists
    | ParseImportList ImportKind String
    | ImportActionList (Maybe ProjectId) String
    | ImportSubprojectList ProjectId String
      -- Modal plumbing
    | SubmitPrompt String
    | CloseModal
    | SetActiveSavedView (Maybe String)
    | UpsertSavedView SavedView Bool
    | DeleteSavedView String


type MenuEntry
    = MenuItem String Command
    | MenuSeparator


{-| The dispositions the Inbox processor can reach.
-}
type Disposition
    = CreateNextAction
    | FileAsReference
    | ParkAsSomeday
    | ParkAsBacklog


type alias InboxInput =
    { projectId : Maybe ProjectId
    , projectTitle : String
    , desiredOutcome : String
    , nextAction : String
    , status : ActionStatus
    , context : String
    , waitingSince : String
    , followUp : String
    , energy : Maybe Energy
    , schedule : Maybe ScheduleInput
    , fileOriginal : Bool
    }


noInboxInput : InboxInput
noInboxInput =
    { projectId = Nothing
    , projectTitle = ""
    , desiredOutcome = ""
    , nextAction = ""
    , status = ActionStatus.Next
    , context = ""
    , waitingSince = ""
    , followUp = ""
    , energy = Nothing
    , schedule = Nothing
    , fileOriginal = False
    }


{-| What a Scheduled Action reserves, as the editor stated it.

The start of a timed Action is a local wall-clock value; only the host knows the
zone that turns it into the absolute timestamp the file stores.

-}
type ScheduleInput
    = AllDayOn String
    | TimedAt String Int


type alias NewActionInput =
    { title : String
    , status : ActionStatus
    , projectId : Maybe ProjectId
    , context : String
    , waitingSince : Maybe String
    , followUp : Maybe String
    , schedule : Maybe ScheduleInput
    }


type alias ActionChanges =
    { title : String
    , status : ActionStatus
    , projectId : Maybe ProjectId
    , context : String
    , energy : Maybe Energy
    , due : String
    , waitingSince : Maybe String
    , followUp : String
    , schedule : Maybe ScheduleInput
    }


type alias NewProjectInput =
    { title : String
    , status : ProjectStatus
    , area : String
    , image : String
    , tags : List String
    , parentProjectId : Maybe ProjectId
    }


type alias ProjectChanges =
    { title : String
    , status : ProjectStatus
    , activateAt : String
    , area : String
    , image : String
    , tags : List String
    , reviewed : String
    , parentProjectId : Maybe ProjectId
    }


type ImportKind
    = ImportActions
    | ImportSubprojects



-- ENCODING


encode : Command -> Encode.Value
encode command =
    case command of
        OpenFile path ->
            object "open-file" [ ( "path", Encode.string path ) ]

        OpenInbox ->
            object "open-inbox" []

        QuickCapture ->
            object "quick-capture" []

        ShowProject projectId ->
            object "show-project" [ ( "projectId", Encode.string projectId ) ]

        SetProjectSelection maybeId ->
            object "set-project-selection" (maybeIdField "projectId" maybeId)

        Prompt fields ->
            object "prompt"
                [ ( "title", Encode.string fields.title )
                , ( "placeholder", Encode.string fields.placeholder )
                ]

        ShowMenu x y entries ->
            object "show-menu"
                [ ( "x", Encode.float x )
                , ( "y", Encode.float y )
                , ( "entries", Encode.list encodeMenuEntry entries )
                ]

        NewActionModal maybeId ->
            object "create-action" (maybeIdField "projectId" maybeId)

        NewProjectModal maybeId status ->
            object "create-project" (( "status", ProjectStatus.encode status ) :: maybeIdField "parentProjectId" maybeId)

        EditActionModal actionId ->
            object "edit-action" [ ( "actionId", Encode.string actionId ) ]

        EditProjectModal projectId ->
            object "edit-project" [ ( "projectId", Encode.string projectId ) ]

        ImportActionsModal projectId ->
            object "import-actions" [ ( "projectId", Encode.string projectId ) ]

        ImportSubprojectsModal projectId ->
            object "import-subprojects" [ ( "projectId", Encode.string projectId ) ]

        BatchProjectTagsModal projectIds ->
            object "batch-project-tags" [ ( "projectIds", Encode.list Encode.string projectIds ) ]

        BatchProjectParentModal projectIds ->
            object "batch-project-parent" [ ( "projectIds", Encode.list Encode.string projectIds ) ]

        ProjectDependenciesModal projectId ->
            object "project-dependencies" [ ( "projectId", Encode.string projectId ) ]

        SetActionStatus actionId status ->
            object "set-action-status"
                [ ( "actionId", Encode.string actionId ), ( "status", ActionStatus.encode status ) ]

        SetActionPriorities actionIds ->
            object "set-action-priorities"
                [ ( "actionIds", Encode.list Encode.string actionIds ) ]

        SetActionContext actionId context ->
            object "update-action"
                [ ( "actionId", Encode.string actionId ), ( "context", Encode.string context ) ]

        TrashAction actionId ->
            object "trash-action" [ ( "actionId", Encode.string actionId ) ]

        CreateAction input ->
            object "save-new-action"
                [ ( "input"
                  , Encode.object
                        ([ ( "title", Encode.string input.title )
                         , ( "status", ActionStatus.encode input.status )
                         , ( "context", Encode.string input.context )
                         ]
                            ++ maybeIdField "projectId" input.projectId
                            ++ maybeStringField "waitingSince" input.waitingSince
                            ++ maybeStringField "followUp" input.followUp
                            ++ scheduleField input.schedule
                        )
                  )
                ]

        UpdateAction actionId changes ->
            object "save-action"
                [ ( "actionId", Encode.string actionId )
                , ( "changes"
                  , Encode.object
                        ([ ( "title", Encode.string changes.title )
                         , ( "status", ActionStatus.encode changes.status )
                         , ( "projectId", Encode.string (Maybe.withDefault "" changes.projectId) )
                         , ( "context", Encode.string changes.context )
                         , ( "energy", Encode.string (Maybe.map Energy.key changes.energy |> Maybe.withDefault "") )
                         , ( "due", Encode.string changes.due )
                         , ( "followUp", Encode.string changes.followUp )
                         ]
                            ++ maybeStringField "waitingSince" changes.waitingSince
                            ++ scheduleField changes.schedule
                        )
                  )
                ]

        ScheduleAction actionId schedule ->
            object "schedule-action"
                ([ ( "actionId", Encode.string actionId ) ] ++ scheduleField (Just schedule))

        ConvertActionToSubproject fields ->
            object "convert-action-to-subproject"
                [ ( "actionId", Encode.string fields.actionId )
                , ( "title", Encode.string fields.title )
                , ( "parentProjectId", Encode.string fields.parentProjectId )
                ]

        SetProjectStatus projectId status ->
            object "set-project-status"
                [ ( "projectId", Encode.string projectId ), ( "status", ProjectStatus.encode status ) ]

        SetProjectArea projectId area ->
            object "set-project-area"
                [ ( "projectId", Encode.string projectId ), ( "area", Encode.string area ) ]

        MoveSubproject projectId status beforeId ->
            object "move-subproject"
                ([ ( "projectId", Encode.string projectId ), ( "status", ProjectStatus.encode status ) ]
                    ++ maybeIdField "beforeId" beforeId
                )

        TrashProject projectId ->
            object "trash-project" [ ( "projectId", Encode.string projectId ) ]

        TrashProjects projectIds ->
            object "trash-projects" [ ( "projectIds", Encode.list Encode.string projectIds ) ]

        CreateProject input ->
            object "save-new-project"
                [ ( "input"
                  , Encode.object
                        ([ ( "title", Encode.string input.title )
                         , ( "status", ProjectStatus.encode input.status )
                         , ( "area", Encode.string input.area )
                         , ( "image", Encode.string input.image )
                         , ( "tags", Encode.list Encode.string input.tags )
                         ]
                            ++ maybeIdField "parentProjectId" input.parentProjectId
                        )
                  )
                ]

        UpdateProject projectId changes ->
            object "save-project"
                [ ( "projectId", Encode.string projectId )
                , ( "changes"
                  , Encode.object
                        [ ( "title", Encode.string changes.title )
                        , ( "status", ProjectStatus.encode changes.status )
                        , ( "activateAt", Encode.string changes.activateAt )
                        , ( "area", Encode.string changes.area )
                        , ( "image", Encode.string changes.image )
                        , ( "tags", Encode.list Encode.string changes.tags )
                        , ( "reviewed", Encode.string changes.reviewed )
                        , ( "parentProjectId", Encode.string (Maybe.withDefault "" changes.parentProjectId) )
                        ]
                  )
                ]

        AddProjectTags projectIds tags ->
            object "add-project-tags"
                [ ( "projectIds", Encode.list Encode.string projectIds )
                , ( "tags", Encode.list Encode.string tags )
                ]

        SetProjectsParent projectIds maybeParent ->
            object "set-projects-parent"
                [ ( "projectIds", Encode.list Encode.string projectIds )
                , ( "parentProjectId", Encode.string (Maybe.withDefault "" maybeParent) )
                ]

        SetProjectBlockers projectId blockers ->
            object "set-project-blockers"
                [ ( "projectId", Encode.string projectId )
                , ( "blockedByProjectIds", Encode.list Encode.string blockers )
                ]

        LoadProjectDetail projectId ->
            object "load-project-detail" [ ( "projectId", Encode.string projectId ) ]

        SetDesiredOutcome projectId body ->
            object "set-desired-outcome"
                [ ( "projectId", Encode.string projectId ), ( "body", Encode.string body ) ]

        AddDiaryEntry projectId body ->
            object "add-diary-entry"
                [ ( "projectId", Encode.string projectId ), ( "body", Encode.string body ) ]

        CreateSupportNote projectId title ->
            object "create-support-note"
                [ ( "projectId", Encode.string projectId ), ( "title", Encode.string title ) ]

        CreateSupportFolder projectId path ->
            object "create-support-folder"
                [ ( "projectId", Encode.string projectId ), ( "path", Encode.string path ) ]

        LinkProjectFile projectId ->
            object "link-project-file" [ ( "projectId", Encode.string projectId ) ]

        UnlinkProjectFile projectId link ->
            object "unlink-project-file" [ ( "projectId", Encode.string projectId ), ( "link", Encode.string link ) ]

        AddProjectLink projectId url title ->
            object "add-project-link"
                [ ( "projectId", Encode.string projectId ), ( "url", Encode.string url ), ( "title", Encode.string title ) ]

        RemoveProjectLink projectId entry ->
            object "remove-project-link" [ ( "projectId", Encode.string projectId ), ( "entry", Encode.string entry ) ]

        ReadSupportNote projectId path ->
            object "read-support-note"
                [ ( "projectId", Encode.string projectId ), ( "path", Encode.string path ) ]

        UpdateSupportNote projectId path body ->
            object "update-support-note"
                [ ( "projectId", Encode.string projectId )
                , ( "path", Encode.string path )
                , ( "body", Encode.string body )
                ]

        SaveProjectPreferences preferences ->
            object "save-project-preferences"
                [ ( "columns", Encode.list ProjectStatus.encode preferences.columns )
                , ( "showImages", Encode.bool preferences.showImages )
                , ( "columnsBy", Encode.string (Settings.projectColumnsByKey preferences.columnsBy) )
                , ( "sections", Encode.string (Settings.projectSectionsKey preferences.sections) )
                ]

        ReviewSomedayProject projectId activateAt ->
            object "review-someday-project"
                [ ( "projectId", Encode.string projectId ), ( "activateAt", Encode.string activateAt ) ]

        OpenSomedayReview ->
            object "open-someday-review" []

        DelegateProject projectId ->
            object "delegate-project" [ ( "projectId", Encode.string projectId ) ]

        AnswerAgentQuestion runId questionId answer ->
            object "answer-agent-question"
                [ ( "runId", Encode.string runId )
                , ( "questionId", Encode.string questionId )
                , ( "answer", Encode.string answer )
                ]

        StopAgentRun runId ->
            object "stop-agent-run" [ ( "runId", Encode.string runId ) ]

        RerunAgentRun runId ->
            object "rerun-agent-run" [ ( "runId", Encode.string runId ) ]

        DeleteAgentRun runId ->
            object "delete-agent-run" [ ( "runId", Encode.string runId ) ]

        OpenPomodoro projectId ->
            object "open-pomodoro" [ ( "projectId", Encode.string projectId ) ]

        StartPomodoro fields ->
            object "start-pomodoro"
                [ ( "projectId", Encode.string fields.projectId )
                , ( "intention", Encode.string fields.intention )
                , ( "focusActionIds", Encode.list Encode.string fields.focusActionIds )
                , ( "minutes", Encode.int fields.minutes )
                ]

        PausePomodoro ->
            object "pause-pomodoro" []

        ResumePomodoro ->
            object "resume-pomodoro" []

        FinishPomodoro outcome reflection ->
            object "finish-pomodoro"
                [ ( "outcome", Maybe.map PomodoroOutcome.encode outcome |> Maybe.withDefault Encode.null )
                , ( "reflection", Encode.string reflection )
                ]

        DiscardPomodoro ->
            object "discard-pomodoro" []

        CompletePomodoroAction actionId ->
            object "complete-pomodoro-action" [ ( "actionId", Encode.string actionId ) ]

        StartChecklistPomodoro fields ->
            object "start-checklist-pomodoro"
                [ ( "path", Encode.string fields.path )
                , ( "intention", Encode.string fields.intention )
                , ( "minutes", Encode.int fields.minutes )
                ]

        OpenChecklistPomodoro path ->
            object "open-checklist-pomodoro" [ ( "path", Encode.string path ) ]

        StartChecklistRun path ->
            object "start-checklist-run" [ ( "path", Encode.string path ) ]

        ShowChecklistRun maybeRunId ->
            object "show-checklist-run" [ ( "runId", Maybe.map Encode.string maybeRunId |> Maybe.withDefault Encode.null ) ]

        OpenChecklistRun runId ->
            object "open-checklist-run" [ ( "runId", Encode.string runId ) ]

        MarkChecklistItem fields ->
            object "mark-checklist-item"
                [ ( "runId", Encode.string fields.runId )
                , ( "key", Encode.string fields.key )
                , ( "state", Checklist.encodeMarkState fields.state )
                ]

        FinishChecklistRun runId ->
            object "finish-checklist-run" [ ( "runId", Encode.string runId ) ]

        DiscardChecklistRun runId ->
            object "discard-checklist-run" [ ( "runId", Encode.string runId ) ]

        CaptureFromChecklist fields ->
            object "capture-from-checklist" [ ( "path", Encode.string fields.path ), ( "text", Encode.string fields.text ) ]

        LoadReviewProject projectId ->
            object "load-review-project" [ ( "projectId", Encode.string projectId ) ]

        CreateReviewAction fields ->
            object "create-review-action"
                [ ( "title", Encode.string fields.title )
                , ( "projectId", Encode.string fields.projectId )
                , ( "context", Encode.string fields.context )
                ]

        CompleteProjectReview projectId desiredOutcome activeIds ->
            reviewCommand "complete-project-review" projectId desiredOutcome activeIds

        MoveReviewToSomeday projectId desiredOutcome activeIds ->
            reviewCommand "move-review-to-someday" projectId desiredOutcome activeIds

        LoadBrainstormOutcome projectId ->
            object "load-brainstorm-outcome" [ ( "projectId", Encode.string projectId ) ]

        SaveBrainstorm actionId ideas maybeOutcome ->
            object "save-brainstorm"
                ([ ( "actionId", Encode.string actionId ), ( "ideas", Encode.string ideas ) ]
                    ++ maybeStringField "desiredOutcome" maybeOutcome
                )

        SaveStandaloneBrainstorm topic ideas ->
            object "save-standalone-brainstorm"
                [ ( "topic", Encode.string topic ), ( "ideas", Encode.string ideas ) ]

        ShuffleBrainstormWords ->
            object "shuffle-brainstorm-words" []

        FocusBrainstormIdeas start end ->
            object "focus-brainstorm-ideas" [ ( "start", Encode.int start ), ( "end", Encode.int end ) ]

        SuggestBrainstormIdeas fields ->
            object "suggest-brainstorm-ideas"
                [ ( "topic", Encode.string fields.topic )
                , ( "desiredOutcome", Encode.string fields.desiredOutcome )
                , ( "ideas", Encode.string fields.ideas )
                , ( "offered", Encode.list Encode.string fields.offered )
                ]

        RefreshFeeds ->
            object "refresh-feeds" []

        AddFeed ->
            object "add-feed" []

        KeepFeedItems keys ->
            object "keep-feed-items" [ ( "keys", Encode.list Encode.string keys ) ]

        ReadFeedItem key comments ->
            object "read-feed-item" [ ( "key", Encode.string key ), ( "comments", Encode.bool comments ) ]

        DiscardFeedItems keys ->
            object "discard-feed-items" [ ( "keys", Encode.list Encode.string keys ) ]

        UndoFeedDiscard ->
            object "undo-feed-discard" []

        OpenLink url ->
            object "open-link" [ ( "url", Encode.string url ) ]

        OpenNoteLink link sourcePath ->
            object "open-note-link" [ ( "link", Encode.string link ), ( "sourcePath", Encode.string sourcePath ) ]

        ReadInboxBody itemId ->
            object "read-inbox-body" [ ( "itemId", Encode.string itemId ) ]

        ReadDesiredOutcome projectId ->
            object "read-desired-outcome" [ ( "projectId", Encode.string projectId ) ]

        ShowProjectIssues ->
            object "show-project-issues" []

        TrashInboxItem itemId ->
            object "trash-inbox-item" [ ( "itemId", Encode.string itemId ) ]

        OpenMail itemId ->
            object "open-mail" [ ( "itemId", Encode.string itemId ) ]

        ReviewPullRequest itemId ->
            object "review-pull-request" [ ( "itemId", Encode.string itemId ) ]

        ProcessInbox itemId disposition input ->
            object "process-inbox"
                [ ( "itemId", Encode.string itemId )
                , ( "operation", Encode.string (dispositionKey disposition) )
                , ( "input", encodeInboxInput input )
                ]

        CaptureInboxItem title ->
            object "capture-inbox-item" [ ( "title", Encode.string title ) ]

        ParseImportList kind text ->
            object "parse-import-list"
                [ ( "kind", Encode.string (importKindKey kind) ), ( "text", Encode.string text ) ]

        ImportActionList maybeProjectId text ->
            object "import-action-list"
                ([ ( "text", Encode.string text ) ] ++ maybeIdField "projectId" maybeProjectId)

        ImportSubprojectList parentProjectId text ->
            object "import-subproject-list"
                [ ( "parentProjectId", Encode.string parentProjectId ), ( "text", Encode.string text ) ]

        SubmitPrompt value ->
            object "submit-prompt" [ ( "value", Encode.string value ) ]

        CloseModal ->
            object "close-modal" []

        SetActiveSavedView maybeId ->
            object "set-active-saved-view"
                [ ( "savedViewId", Maybe.map Encode.string maybeId |> Maybe.withDefault Encode.null ) ]

        UpsertSavedView saved activate ->
            object "upsert-saved-view"
                [ ( "view", Settings.encodeSavedView saved ), ( "activate", Encode.bool activate ) ]

        DeleteSavedView savedId ->
            object "delete-saved-view" [ ( "savedViewId", Encode.string savedId ) ]


encodeMenuEntry : MenuEntry -> Encode.Value
encodeMenuEntry entry =
    case entry of
        MenuSeparator ->
            Encode.object [ ( "separator", Encode.bool True ) ]

        MenuItem label command ->
            Encode.object [ ( "label", Encode.string label ), ( "command", encode command ) ]


encodeInboxInput : InboxInput -> Encode.Value
encodeInboxInput input =
    Encode.object
        ([ ( "status", ActionStatus.encode input.status ), ( "fileOriginal", Encode.bool input.fileOriginal ) ]
            ++ maybeIdField "projectId" input.projectId
            ++ presentString "projectTitle" input.projectTitle
            ++ presentString "desiredOutcome" input.desiredOutcome
            ++ presentString "nextAction" input.nextAction
            ++ presentString "context" input.context
            ++ maybeStringField "energy" (Maybe.map Energy.key input.energy)
            ++ (if input.status == ActionStatus.Waiting then
                    presentString "waitingSince" input.waitingSince ++ presentString "followUp" input.followUp

                else
                    []
               )
            ++ scheduleField input.schedule
        )


dispositionKey : Disposition -> String
dispositionKey disposition =
    case disposition of
        CreateNextAction ->
            "next-action"

        FileAsReference ->
            "file"

        ParkAsSomeday ->
            "someday"

        ParkAsBacklog ->
            "backlog"


importKindKey : ImportKind -> String
importKindKey kind =
    case kind of
        ImportActions ->
            "actions"

        ImportSubprojects ->
            "subprojects"


reviewCommand : String -> ProjectId -> String -> List ProjectId -> Encode.Value
reviewCommand kind projectId desiredOutcome activeIds =
    object kind
        [ ( "projectId", Encode.string projectId )
        , ( "desiredOutcome", Encode.string desiredOutcome )
        , ( "activeProjectIds", Encode.list Encode.string activeIds )
        ]


scheduleField : Maybe ScheduleInput -> List ( String, Encode.Value )
scheduleField maybeSchedule =
    case maybeSchedule of
        Nothing ->
            []

        Just (AllDayOn date) ->
            [ ( "schedule", Encode.object [ ( "kind", Encode.string "all-day" ), ( "date", Encode.string date ) ] ) ]

        Just (TimedAt localStart minutes) ->
            [ ( "schedule"
              , Encode.object
                    [ ( "kind", Encode.string "timed" )
                    , ( "localStart", Encode.string localStart )
                    , ( "durationMinutes", Encode.int minutes )
                    ]
              )
            ]


object : String -> List ( String, Encode.Value ) -> Encode.Value
object kind fields =
    Encode.object (( "type", Encode.string kind ) :: fields)


maybeIdField : String -> Maybe String -> List ( String, Encode.Value )
maybeIdField name maybeValue =
    case maybeValue of
        Just value ->
            [ ( name, Encode.string value ) ]

        Nothing ->
            []


maybeStringField : String -> Maybe String -> List ( String, Encode.Value )
maybeStringField =
    maybeIdField


presentString : String -> String -> List ( String, Encode.Value )
presentString name value =
    if String.isEmpty value then
        []

    else
        [ ( name, Encode.string value ) ]
