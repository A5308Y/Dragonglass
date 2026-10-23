module Gtd.Command.ProjectReview exposing (Command(..), encode)

{-| Commands the Project Review workflow alone is allowed to send.
-}

import Gtd.ActionStatus exposing (ActionStatus)
import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.ProjectStatus exposing (ProjectStatus)
import Json.Encode as Encode


type Command
    = LoadReviewProject ProjectId
    | CreateReviewAction { title : String, projectId : ProjectId, context : String, mode : String }
    | AddDiaryEntry ProjectId String
    | CompleteProjectReview ProjectId String (List ProjectId)
    | MoveReviewToSomeday ProjectId String (List ProjectId)
    | CompleteReviewProject ProjectId String
    | TrashProject ProjectId
    | SetProjectStatus ProjectId ProjectStatus
    | NewProjectModal (Maybe ProjectId) ProjectStatus
    | OpenFile String
      -- The Project's page, as the Projects view shows it.
    | ShowProject ProjectId
    | EditActionModal ActionId
    | SetActionStatus ActionId ActionStatus
    | TrashAction ActionId
    | OpenSomedayReview


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            LoadReviewProject projectId ->
                Base.LoadReviewProject projectId

            CreateReviewAction fields ->
                Base.CreateReviewAction fields

            AddDiaryEntry projectId body ->
                Base.AddDiaryEntry projectId body

            CompleteProjectReview projectId outcome activeIds ->
                Base.CompleteProjectReview projectId outcome activeIds

            MoveReviewToSomeday projectId outcome activeIds ->
                Base.MoveReviewToSomeday projectId outcome activeIds

            CompleteReviewProject projectId outcome ->
                Base.CompleteReviewProject projectId outcome

            TrashProject projectId ->
                Base.TrashProject projectId

            SetProjectStatus projectId status ->
                Base.SetProjectStatus projectId status

            NewProjectModal parentId status ->
                Base.NewProjectModal parentId status

            OpenFile path ->
                Base.OpenFile path

            ShowProject projectId ->
                Base.ShowProject projectId

            EditActionModal actionId ->
                Base.EditActionModal actionId

            SetActionStatus actionId status ->
                Base.SetActionStatus actionId status

            TrashAction actionId ->
                Base.TrashAction actionId

            OpenSomedayReview ->
                Base.OpenSomedayReview
        )
