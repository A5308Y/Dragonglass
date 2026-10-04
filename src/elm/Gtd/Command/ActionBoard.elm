module Gtd.Command.ActionBoard exposing (Command(..), MenuEntry(..), encode)

{-| Commands the Action Board alone is allowed to send.
-}

import Gtd.ActionStatus exposing (ActionStatus)
import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.Settings exposing (SavedView)
import Json.Encode as Encode


type Command
    = NewActionModal (Maybe ProjectId)
    | QuickCapture
    | OpenInbox
    | OpenFile String
    | OpenLink String
    | OpenNoteLink String String
    | ShowProject ProjectId
    | EditActionModal ActionId
    | SetActionStatus ActionId ActionStatus
    | SetActionPriorities (List ActionId)
    | SetActionContext ActionId String
    | TrashAction ActionId
    | DelegateActionByEmail ActionId
    | MoveActionToInbox ActionId
    | SetActiveSavedView (Maybe String)
    | UpsertSavedView SavedView Bool
    | DeleteSavedView String
    | Prompt { title : String, placeholder : String }
    | ShowMenu Float Float (List MenuEntry)


type MenuEntry
    = MenuItem String Command
    | MenuSeparator


encode : Command -> Encode.Value
encode command =
    Base.encode (toBase command)


toBase : Command -> Base.Command
toBase command =
    case command of
        NewActionModal projectId ->
            Base.NewActionModal projectId

        QuickCapture ->
            Base.QuickCapture

        OpenFile path ->
            Base.OpenFile path

        OpenLink url ->
            Base.OpenLink url

        OpenNoteLink link sourcePath ->
            Base.OpenNoteLink link sourcePath

        OpenInbox ->
            Base.OpenInbox

        ShowProject projectId ->
            Base.ShowProject projectId

        EditActionModal actionId ->
            Base.EditActionModal actionId

        SetActionStatus actionId status ->
            Base.SetActionStatus actionId status

        SetActionPriorities actionIds ->
            Base.SetActionPriorities actionIds

        SetActionContext actionId context ->
            Base.SetActionContext actionId context

        TrashAction actionId ->
            Base.TrashAction actionId

        DelegateActionByEmail actionId ->
            Base.DelegateActionByEmail actionId

        MoveActionToInbox actionId ->
            Base.MoveActionToInbox actionId

        SetActiveSavedView savedId ->
            Base.SetActiveSavedView savedId

        UpsertSavedView saved activate ->
            Base.UpsertSavedView saved activate

        DeleteSavedView savedId ->
            Base.DeleteSavedView savedId

        Prompt fields ->
            Base.Prompt fields

        ShowMenu x y entries ->
            Base.ShowMenu x y (List.map menuToBase entries)


menuToBase : MenuEntry -> Base.MenuEntry
menuToBase entry =
    case entry of
        MenuItem label command ->
            Base.MenuItem label (toBase command)

        MenuSeparator ->
            Base.MenuSeparator
