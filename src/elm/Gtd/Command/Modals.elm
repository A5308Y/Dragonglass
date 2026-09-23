module Gtd.Command.Modals exposing
    ( ActionChanges
    , Command(..)
    , ImportKind(..)
    , NewActionInput
    , NewProjectInput
    , ProjectChanges
    , ScheduleInput(..)
    , encode
    )

{-| Commands the shared modal program alone is allowed to send.
-}

import Gtd.ActionStatus exposing (ActionStatus)
import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.ProjectStatus exposing (ProjectStatus)
import Json.Encode as Encode


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
    , energy : String
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


type Command
    = CreateAction NewActionInput
    | UpdateAction ActionId ActionChanges
    | ScheduleAction ActionId ScheduleInput
    | ConvertActionToSubproject { actionId : ActionId, title : String, parentProjectId : ProjectId }
    | CreateProject NewProjectInput
    | UpdateProject ProjectId ProjectChanges
    | TrashProject ProjectId
    | AddProjectTags (List ProjectId) (List String)
    | SetProjectsParent (List ProjectId) (Maybe ProjectId)
    | SetProjectBlockers ProjectId (List ProjectId)
    | ParseImportList ImportKind String
    | ImportActionList (Maybe ProjectId) String
    | ImportSubprojectList ProjectId String
    | CaptureInboxItem String
    | SubmitPrompt String
    | CloseModal


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            CreateAction input ->
                Base.CreateAction (newActionToBase input)

            UpdateAction actionId changes ->
                Base.UpdateAction actionId (actionChangesToBase changes)

            ScheduleAction actionId schedule ->
                Base.ScheduleAction actionId (scheduleToBase schedule)

            ConvertActionToSubproject fields ->
                Base.ConvertActionToSubproject fields

            CreateProject input ->
                Base.CreateProject input

            UpdateProject projectId changes ->
                Base.UpdateProject projectId changes

            TrashProject projectId ->
                Base.TrashProject projectId

            AddProjectTags projectIds tags ->
                Base.AddProjectTags projectIds tags

            SetProjectsParent projectIds parentId ->
                Base.SetProjectsParent projectIds parentId

            SetProjectBlockers projectId blockerIds ->
                Base.SetProjectBlockers projectId blockerIds

            ParseImportList kind body ->
                Base.ParseImportList (importKindToBase kind) body

            ImportActionList projectId body ->
                Base.ImportActionList projectId body

            ImportSubprojectList projectId body ->
                Base.ImportSubprojectList projectId body

            CaptureInboxItem title ->
                Base.CaptureInboxItem title

            SubmitPrompt value ->
                Base.SubmitPrompt value

            CloseModal ->
                Base.CloseModal
        )


newActionToBase : NewActionInput -> Base.NewActionInput
newActionToBase input =
    { title = input.title
    , status = input.status
    , projectId = input.projectId
    , context = input.context
    , waitingSince = input.waitingSince
    , followUp = input.followUp
    , schedule = Maybe.map scheduleToBase input.schedule
    }


actionChangesToBase : ActionChanges -> Base.ActionChanges
actionChangesToBase changes =
    { title = changes.title
    , status = changes.status
    , projectId = changes.projectId
    , context = changes.context
    , energy = changes.energy
    , due = changes.due
    , waitingSince = changes.waitingSince
    , followUp = changes.followUp
    , schedule = Maybe.map scheduleToBase changes.schedule
    }


scheduleToBase : ScheduleInput -> Base.ScheduleInput
scheduleToBase schedule =
    case schedule of
        AllDayOn date ->
            Base.AllDayOn date

        TimedAt start minutes ->
            Base.TimedAt start minutes


importKindToBase : ImportKind -> Base.ImportKind
importKindToBase kind =
    case kind of
        ImportActions ->
            Base.ImportActions

        ImportSubprojects ->
            Base.ImportSubprojects
