module Gtd.Command.Inbox exposing (Command(..), Disposition(..), InboxInput, encode)

{-| Commands and processing choices owned by the Inbox surface.
-}

import Gtd.Command as Base
import Gtd.ActionStatus exposing (ActionStatus)
import Gtd.Energy exposing (Energy)
import Gtd.Id exposing (InboxItemId, ProjectId)
import Json.Encode as Encode


type Command
    = QuickCapture
    | OpenFile String
    | ReadInboxBody InboxItemId
      -- An existing Project's vision, to show while processing into it.
    | ReadDesiredOutcome ProjectId
      -- The Projects board with only the Projects that have an issue.
    | ShowProjectIssues
    | TrashInboxItem InboxItemId
    | OpenMail InboxItemId
      -- A Next Action to review the pull request the Item links, then the Item is deleted.
    | ReviewPullRequest InboxItemId
    | ProcessInbox InboxItemId Disposition InboxInput


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
    , estimate : Maybe Int
    , schedule : Maybe Base.ScheduleInput
    , fileOriginal : Bool
    }


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            QuickCapture ->
                Base.QuickCapture

            OpenFile path ->
                Base.OpenFile path

            ReadInboxBody itemId ->
                Base.ReadInboxBody itemId

            ReadDesiredOutcome projectId ->
                Base.ReadDesiredOutcome projectId

            ShowProjectIssues ->
                Base.ShowProjectIssues

            TrashInboxItem itemId ->
                Base.TrashInboxItem itemId

            OpenMail itemId ->
                Base.OpenMail itemId

            ReviewPullRequest itemId ->
                Base.ReviewPullRequest itemId

            ProcessInbox itemId disposition input ->
                Base.ProcessInbox itemId (dispositionToBase disposition) input
        )


dispositionToBase : Disposition -> Base.Disposition
dispositionToBase disposition =
    case disposition of
        CreateNextAction ->
            Base.CreateNextAction

        FileAsReference ->
            Base.FileAsReference

        ParkAsSomeday ->
            Base.ParkAsSomeday

        ParkAsBacklog ->
            Base.ParkAsBacklog
