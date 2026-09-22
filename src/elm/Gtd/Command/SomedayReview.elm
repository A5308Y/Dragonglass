module Gtd.Command.SomedayReview exposing (Command(..), encode)

{-| Commands the Someday/Maybe Review alone is allowed to send.
-}

import Gtd.Command as Base
import Gtd.Id exposing (ProjectId)
import Gtd.ProjectStatus exposing (ProjectStatus)
import Json.Encode as Encode


type Command
    = SetProjectStatus ProjectId ProjectStatus
    | MoveSubproject ProjectId ProjectStatus (Maybe ProjectId)
    | ReviewSomedayProject ProjectId String
    | ShowProject ProjectId


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            SetProjectStatus projectId status ->
                Base.SetProjectStatus projectId status

            MoveSubproject projectId status beforeId ->
                Base.MoveSubproject projectId status beforeId

            ReviewSomedayProject projectId activateAt ->
                Base.ReviewSomedayProject projectId activateAt

            ShowProject projectId ->
                Base.ShowProject projectId
        )
