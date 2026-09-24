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
    | NewProjectModal (Maybe ProjectId) ProjectStatus
    | SetProjectSelection (Maybe ProjectId)
    | EditActionModal ActionId
    | SetActionStatus ActionId ActionStatus
    | TrashAction ActionId
    | EditProjectModal ProjectId
    | SetProjectStatus ProjectId ProjectStatus
    | SetProjectArea ProjectId String
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
    | LinkProjectFile ProjectId
    | UnlinkProjectFile ProjectId String
    | AddProjectLink ProjectId String String
    | RemoveProjectLink ProjectId String
    | OpenLink String
    | ReadSupportNote ProjectId String
    | UpdateSupportNote ProjectId String String
    | SaveProjectPreferences { columns : List ProjectStatus, showImages : Bool, groupByArea : Bool }
    | OpenSomedayReview
    | OpenPomodoro ProjectId
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

        NewProjectModal parentId status ->
            Base.NewProjectModal parentId status

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

        SetProjectArea projectId area ->
            Base.SetProjectArea projectId area

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

        LinkProjectFile projectId ->
            Base.LinkProjectFile projectId

        UnlinkProjectFile projectId link ->
            Base.UnlinkProjectFile projectId link

        AddProjectLink projectId url title ->
            Base.AddProjectLink projectId url title

        RemoveProjectLink projectId entry ->
            Base.RemoveProjectLink projectId entry

        OpenLink url ->
            Base.OpenLink url

        ReadSupportNote projectId path ->
            Base.ReadSupportNote projectId path

        UpdateSupportNote projectId path body ->
            Base.UpdateSupportNote projectId path body

        SaveProjectPreferences preferences ->
            Base.SaveProjectPreferences preferences

        OpenSomedayReview ->
            Base.OpenSomedayReview

        OpenPomodoro projectId ->
            Base.OpenPomodoro projectId

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
