module Gtd.Command.Inbox exposing (Command(..), Disposition(..), InboxInput, encode)

{-| Commands and processing choices owned by the Inbox surface.
-}

import Gtd.Command as Base
import Gtd.ActionStatus exposing (ActionStatus)
import Gtd.Id exposing (InboxItemId, ProjectId)
import Json.Encode as Encode


type Command
    = QuickCapture
    | OpenFile String
    | ReadInboxBody InboxItemId
    | TrashInboxItem InboxItemId
    | ProcessInbox InboxItemId Disposition InboxInput


type Disposition
    = CreateNextAction
    | FileAsReference
    | ParkAsSomeday


type alias InboxInput =
    { projectId : Maybe ProjectId
    , projectTitle : String
    , desiredOutcome : String
    , nextAction : String
    , status : ActionStatus
    , context : String
    , waitingSince : String
    , schedule : Maybe Base.ScheduleInput
    , work : Bool
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

            TrashInboxItem itemId ->
                Base.TrashInboxItem itemId

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
