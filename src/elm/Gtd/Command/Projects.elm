module Gtd.Command.Projects exposing (Command(..), MenuEntry(..), encode)

{-| Commands the Projects surface alone is allowed to send.
-}

import Gtd.ActionStatus exposing (ActionStatus)
import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.ProjectStatus exposing (ProjectStatus)
import Json.Encode as Encode


type Command
    = NewActionModal (Maybe ProjectId)
    | NewProjectModal (Maybe ProjectId)
    | SetProjectSelection (Maybe ProjectId)
    | EditActionModal ActionId
    | SetActionStatus ActionId ActionStatus
    | TrashAction ActionId
    | EditProjectModal ProjectId
    | SetProjectStatus ProjectId ProjectStatus
    | MoveSubproject ProjectId ProjectStatus (Maybe ProjectId)
    | TrashProject ProjectId
    | TrashProjects (List ProjectId)
    | BatchProjectTagsModal (List ProjectId)
    | BatchProjectParentModal (List ProjectId)
    | ProjectDependenciesModal ProjectId
    | ImportActionsModal ProjectId
    | ImportSubprojectsModal ProjectId
    | LoadProjectDetail ProjectId
    | SetDesiredOutcome ProjectId String
    | AddDiaryEntry ProjectId String
    | CreateSupportNote ProjectId String
    | CreateSupportFolder ProjectId String
    | ReadSupportNote ProjectId String
    | UpdateSupportNote ProjectId String String
    | SaveProjectPreferences (List ProjectStatus) Bool
    | OpenSomedayReview
    | OpenFile String
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

        NewProjectModal parentId ->
            Base.NewProjectModal parentId

        SetProjectSelection projectId ->
            Base.SetProjectSelection projectId

        EditActionModal actionId ->
            Base.EditActionModal actionId

        SetActionStatus actionId status ->
            Base.SetActionStatus actionId status

        TrashAction actionId ->
            Base.TrashAction actionId

        EditProjectModal projectId ->
            Base.EditProjectModal projectId

        SetProjectStatus projectId status ->
            Base.SetProjectStatus projectId status

        MoveSubproject projectId status beforeId ->
            Base.MoveSubproject projectId status beforeId

        TrashProject projectId ->
            Base.TrashProject projectId

        TrashProjects projectIds ->
            Base.TrashProjects projectIds

        BatchProjectTagsModal projectIds ->
            Base.BatchProjectTagsModal projectIds

        BatchProjectParentModal projectIds ->
            Base.BatchProjectParentModal projectIds

        ProjectDependenciesModal projectId ->
            Base.ProjectDependenciesModal projectId

        ImportActionsModal projectId ->
            Base.ImportActionsModal projectId

        ImportSubprojectsModal projectId ->
            Base.ImportSubprojectsModal projectId

        LoadProjectDetail projectId ->
            Base.LoadProjectDetail projectId

        SetDesiredOutcome projectId body ->
            Base.SetDesiredOutcome projectId body

        AddDiaryEntry projectId body ->
            Base.AddDiaryEntry projectId body

        CreateSupportNote projectId title ->
            Base.CreateSupportNote projectId title

        CreateSupportFolder projectId path ->
            Base.CreateSupportFolder projectId path

        ReadSupportNote projectId path ->
            Base.ReadSupportNote projectId path

        UpdateSupportNote projectId path body ->
            Base.UpdateSupportNote projectId path body

        SaveProjectPreferences columns showImages ->
            Base.SaveProjectPreferences columns showImages

        OpenSomedayReview ->
            Base.OpenSomedayReview

        OpenFile path ->
            Base.OpenFile path

        ShowMenu x y entries ->
            Base.ShowMenu x y (List.map menuToBase entries)


menuToBase : MenuEntry -> Base.MenuEntry
menuToBase entry =
    case entry of
        MenuItem label command ->
            Base.MenuItem label (toBase command)

        MenuSeparator ->
            Base.MenuSeparator
